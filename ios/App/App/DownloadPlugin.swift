import Foundation
import Capacitor

/**
 * 原生直落磁盘下载（iOS 端，与 Android StoragePlugin.downloadFile 语义对齐）：
 * URLSession dataTask 流式写 destPath + ".part"，支持 Range 断点续传；
 * 进度经 downloadProgress 事件回传（~200ms 节流的小 JSON），成功后改名 destPath
 * 并 resolve { path, size, contentType }；cancelDownload 中断并保留 .part（幂等）。
 * 非 Range 服务器（200 整包）与 416（.part 已完整/超界）处理同 Android。
 *
 * 注册方式（Capacitor 8 官方 "Custom Code > iOS"）：实现 CAPBridgedPlugin 协议，
 * 在 ViewController.capacitorDidLoad() 里 registerPluginInstance，无 CAP_PLUGIN 宏。
 */
@objc(DownloadPlugin)
public class DownloadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DownloadPlugin"
    public let jsName = "Download"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "downloadFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
    ]

    private let handlersQueue = DispatchQueue(label: "mf.download.handlers")
    private var handlersById: [String: DownloadHandler] = [:]

    /** 直落磁盘下载：流式写 destPath（先写 destPath + ".part"，成功后改名） */
    @objc func downloadFile(_ call: CAPPluginCall) {
        guard let taskId = call.getString("taskId"), !taskId.isEmpty,
              let urlStr = call.getString("url"), !urlStr.isEmpty,
              let destPath = call.getString("destPath"), !destPath.isEmpty else {
            call.reject("缺少下载参数")
            return
        }
        var headers: [String: String] = [:]
        if let obj = call.getObject("headers") {
            for (key, value) in obj {
                if let s = value as? String, !s.isEmpty {
                    headers[key] = s
                } else if let n = value as? NSNumber {
                    headers[key] = n.stringValue
                }
            }
        }
        guard let handler = DownloadHandler(taskId: taskId, urlStr: urlStr, headers: headers,
                                            destPath: destPath, call: call, plugin: self) else {
            call.reject("无效的下载地址")
            return
        }
        var existed = false
        handlersQueue.sync {
            existed = handlersById[taskId] != nil
            if !existed {
                handlersById[taskId] = handler
            }
        }
        if existed {
            call.reject("该任务已在下载中")
            return
        }
        handler.start()
    }

    /** 中断指定 taskId 的下载（保留 .part 供续传）；任务不存在也 resolve（幂等） */
    @objc func cancelDownload(_ call: CAPPluginCall) {
        if let taskId = call.getString("taskId") {
            handlersQueue.sync {
                handlersById[taskId]?.cancel()
            }
        }
        call.resolve(["cancelled": true])
    }

    fileprivate func removeHandler(_ handler: DownloadHandler) {
        handlersQueue.async { [weak self] in
            self?.handlersById[handler.taskId] = nil
        }
    }
}

/** 单个下载的生命周期（URLSessionDataDelegate）：一个下载一个 Session，结束即 invalidate */
private final class DownloadHandler: NSObject, URLSessionDataDelegate {
    static let partSuffix = ".part"
    static let progressInterval: TimeInterval = 0.2

    enum FinishKind {
        case success([String: Any])
        case failure(String)
        case cancelled
    }

    let taskId: String
    private let url: URL
    private let headers: [String: String]
    private let destPath: String
    private let call: CAPPluginCall
    private weak var plugin: DownloadPlugin?

    private let lock = NSLock()
    private var cancelled = false
    private var finished = false
    private var outputStream: FileHandle?
    private var session: URLSession?

    // 以下仅 delegate 队列访问（同任务回调串行）
    private var loaded: Int64 = 0
    private var total: Int64 = -1
    private var lastNotifyAt: TimeInterval = 0
    private var contentType: String?
    private var retriedWithoutRange = false

    init?(taskId: String, urlStr: String, headers: [String: String],
          destPath: String, call: CAPPluginCall, plugin: DownloadPlugin) {
        guard let url = URL(string: urlStr), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        self.taskId = taskId
        self.url = url
        self.headers = headers
        self.destPath = destPath
        self.call = call
        self.plugin = plugin
        super.init()
    }

    func start() {
        do {
            let dir = (destPath as NSString).deletingLastPathComponent
            if !dir.isEmpty {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            }
        } catch {
            finish(.failure("无法创建目标文件夹"))
            return
        }
        startRequest(rangeFrom: fileSize(atPath: destPath + Self.partSuffix))
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let handle = outputStream
        outputStream = nil
        let session = self.session
        self.session = nil
        lock.unlock()
        try? handle?.close()
        // invalidateAndCancel 立即断开传输，didCompleteWithError 里收尾（保留 .part）
        session?.invalidateAndCancel()
    }

    private func startRequest(rangeFrom partSize: Int64) {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        // 关掉透明压缩：进度按解码后字节算会与 Content-Length 错位（调用方自带时以调用方为准）
        if headers["Accept-Encoding"] == nil {
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        }
        if partSize > 0 {
            request.setValue("bytes=\(partSize)-", forHTTPHeaderField: "Range")
        }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        lock.lock()
        self.session = session
        lock.unlock()
        session.dataTask(with: request).resume()
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            finish(.failure("无效的下载响应"))
            return
        }
        let status = http.statusCode
        let partPath = destPath + Self.partSuffix
        let partSize = fileSize(atPath: partPath)
        contentType = http.value(forHTTPHeaderField: "Content-Type")

        // 416：.part 已达总长直接收尾；超界丢弃整包重下一次（与 Android 一致）
        if status == 416 && partSize > 0 {
            let rangeTotal = parseContentRange(http.value(forHTTPHeaderField: "Content-Range") ?? "").total
            if rangeTotal > 0 && partSize == rangeTotal {
                completionHandler(.cancel)
                finalize()
            } else if !retriedWithoutRange {
                retriedWithoutRange = true
                try? FileManager.default.removeItem(atPath: partPath)
                // 旧会话即刻废弃（延后一拍避免在回调里重入），didComplete 不会再误报
                let old = session
                DispatchQueue.global().async { old?.finishTasksAndInvalidate() }
                startRequest(rangeFrom: 0)
            } else {
                completionHandler(.cancel)
                finish(.failure("请求失败 (416)"))
            }
            return
        }
        if status >= 400 {
            completionHandler(.cancel)
            finish(.failure("请求失败 (\(status))"))
            return
        }

        // 206 且起点与 .part 对上才追加；否则（200 不支持 Range / 起点漂移 / 全新下载）从头整包写
        var append = false
        total = -1
        if status == 206 && partSize > 0 {
            let contentRange = parseContentRange(http.value(forHTTPHeaderField: "Content-Range") ?? "")
            if contentRange.start == partSize {
                append = true
                total = contentRange.total
            }
        }
        if !append {
            let len = http.expectedContentLength
            total = len > 0 ? Int64(len) : -1
        }
        loaded = append ? partSize : 0

        do {
            if !append && FileManager.default.fileExists(atPath: partPath) {
                try FileManager.default.removeItem(atPath: partPath)
            }
            if !FileManager.default.fileExists(atPath: partPath) {
                guard FileManager.default.createFile(atPath: partPath, contents: nil) else {
                    completionHandler(.cancel)
                    finish(.failure("无法写入下载临时文件"))
                    return
                }
            }
            guard let handle = FileHandle(forWritingAtPath: partPath) else {
                completionHandler(.cancel)
                finish(.failure("无法写入下载临时文件"))
                return
            }
            if append {
                try handle.seekToEnd()
            }
            lock.lock()
            outputStream = handle
            lock.unlock()
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            finish(.failure("无法写入下载临时文件"))
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // 写盘全程持锁：cancel() 在别的线程 close 句柄，FileHandle 写已关闭句柄会抛
        // ObjC 异常（Swift 拦不住），必须与取消串行化
        lock.lock()
        guard let handle = outputStream, !cancelled, !finished else {
            lock.unlock()
            return
        }
        do {
            try handle.write(contentsOf: data)
        } catch {
            lock.unlock()
            finish(.failure("磁盘写入失败"))
            return
        }
        lock.unlock()
        loaded += Int64(data.count)
        let now = Date().timeIntervalSince1970
        if now - lastNotifyAt >= Self.progressInterval {
            lastNotifyAt = now
            plugin?.notifyListeners("downloadProgress", data: [
                "taskId": taskId,
                "loaded": loaded,
                "total": total,
            ])
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let current = self.session
        lock.unlock()
        if current != nil && current !== session {
            // 416 整包重下路径里被放弃的旧会话，新请求已接管
            DispatchQueue.global().async { session.finishTasksAndInvalidate() }
            return
        }
        lock.lock()
        let handle = outputStream
        outputStream = nil
        lock.unlock()
        try? handle?.close()

        if cancelled {
            // 用户取消：保留 .part 供续传
            finish(.cancelled)
            return
        }
        if let error = error {
            if (error as NSError?)?.code == NSURLErrorCancelled {
                // completionHandler(.cancel) 主动放弃的请求：失败原因已在 didReceive 里 finish 过，
                // 能走到这里说明 finish 未发生（如 416 已完整收尾路径），按取消处理即可
                finish(.cancelled)
            } else {
                finish(.failure(error.localizedDescription))
            }
            return
        }
        finalize()
    }

    // MARK: - 收尾

    /** .part 改名收尾（目标目录与 .part 同盘，moveItem 不会跨文件系统） */
    private func finalize() {
        let partPath = destPath + Self.partSuffix
        let fm = FileManager.default
        do {
            if fm.fileExists(atPath: destPath) {
                try fm.removeItem(atPath: destPath)
            }
            try fm.moveItem(atPath: partPath, toPath: destPath)
            var result: [String: Any] = ["path": destPath, "size": fileSize(atPath: destPath)]
            if let ct = contentType, !ct.isEmpty {
                result["contentType"] = ct
            }
            finish(.success(result))
        } catch {
            finish(.failure("保存文件失败：\(error.localizedDescription)"))
        }
    }

    /** 结果只报一次；随后解绑会话并把 handler 从插件表里摘除 */
    private func finish(_ kind: FinishKind) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        let session = self.session
        self.session = nil
        lock.unlock()
        session?.finishTasksAndInvalidate()
        plugin?.removeHandler(self)
        switch kind {
        case .success(let result):
            call.resolve(result)
        case .failure(let message):
            call.reject(message)
        case .cancelled:
            call.reject("下载已取消")
        }
    }

    private func fileSize(atPath path: String) -> Int64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
    }

    /// 解析 "bytes 1024-2047/4096"（416 时是 "bytes */4096"）
    private func parseContentRange(_ s: String) -> (start: Int64, total: Int64) {
        guard let slash = s.lastIndex(of: "/") else { return (-1, -1) }
        let total = Int64(s[s.index(after: slash)...].trimmingCharacters(in: .whitespaces)) ?? -1
        let rangePart = s[s.startIndex..<slash]
        guard let space = rangePart.firstIndex(of: " "),
              let dash = rangePart.firstIndex(of: "-"), space < dash else {
            return (-1, total)
        }
        let start = Int64(rangePart[rangePart.index(after: space)..<dash].trimmingCharacters(in: .whitespaces)) ?? -1
        return (start, total)
    }
}
