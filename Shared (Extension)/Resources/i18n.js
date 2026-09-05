const FALLBACK_MESSAGES = {
    extension_name: "GetV",
    extension_description: "Find and save video, audio, and HLS streams from the current page."
};

export function t(key, substitutions) {
    const localized = globalThis.browser?.i18n?.getMessage?.(key, substitutions);
    return localized || FALLBACK_MESSAGES[key] || key;
}

export function localizeDocument(root = document) {
    const language = globalThis.browser?.i18n?.getUILanguage?.();
    if (language && root.documentElement) root.documentElement.lang = language;
    const translate = container => {
        for (const node of container.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
        for (const [dataName, attribute] of [
            ["i18nTitle", "title"],
            ["i18nPlaceholder", "placeholder"],
            ["i18nAriaLabel", "aria-label"]
        ]) {
            for (const node of container.querySelectorAll(`[data-${dataName.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}]`)) {
                node.setAttribute(attribute, t(node.dataset[dataName]));
            }
        }
    };
    translate(root);
    for (const template of root.querySelectorAll("template")) translate(template.content);
}
