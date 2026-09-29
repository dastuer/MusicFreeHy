import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setupNativeStatusBar } from "./core/native";
import { setupSystemBack } from "./core/systemBack";
import { detectProxy } from "./core/net";
import "./styles/global.css";

void setupNativeStatusBar();
setupSystemBack();

// 先探测同源内置代理再渲染：插件 Worker 初始化 / WebDAV / 媒体直链都依赖它的结果
detectProxy().finally(() => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
});
