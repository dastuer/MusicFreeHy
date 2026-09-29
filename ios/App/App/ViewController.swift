import UIKit
import Capacitor

/**
 * 应用根视图控制器（继承 Capacitor 的桥接控制器）
 *
 * 这里打开 WKWebView 的历史导航手势，iOS 的「侧滑返回」才可用：
 * 前端（core/systemBack.ts）在浮层打开时会 history.pushState 压一条记录，
 * 侧滑 = 回退这条记录 = popstate 事件 → 只关闭正在播放页 / 面板，
 * 不会退出应用（页面最初那条记录之前没有历史，手势到那里就被系统拦住）。
 */
class ViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}
