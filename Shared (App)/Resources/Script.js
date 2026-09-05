function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        const zh = document.documentElement.lang.toLowerCase().startsWith("zh");
        document.getElementsByClassName('platform-mac state-on')[0].innerText = zh ? "GetV 扩展当前已开启。你可以在 Safari 设置的“扩展”部分将其关闭。" : "GetV’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-off')[0].innerText = zh ? "GetV 扩展当前已关闭。你可以在 Safari 设置的“扩展”部分将其开启。" : "GetV’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac state-unknown')[0].innerText = zh ? "你可以在 Safari 设置的“扩展”部分开启 GetV。" : "You can turn on GetV’s extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('platform-mac open-preferences')[0].innerText = zh ? "退出并打开 Safari 设置…" : "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
