// download() resolves when saving starts, not when the file reaches disk.
export async function saveDownload(options, downloads = globalThis.browser?.downloads, document = globalThis.document) {
    if (!downloads?.download || !downloads.onChanged?.addListener || !downloads.search) {
        if (downloads?.download) {
            await downloads.download(options);
        } else {
            const anchor = document.createElement('a');
            anchor.href = options.url;
            anchor.download = options.filename;
            anchor.hidden = true;
            document.body.append(anchor);
            try { anchor.click(); } finally { anchor.remove(); }
        }
        // The caller must keep both the object URL and cache alive until the
        // document closes: there is no reliable completion signal here.
        return false;
    }
    let id;
    const early = [];
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    function changed(delta) {
        if (id === undefined) { early.push(delta); return; }
        if (delta.id !== id) return;
        const state = delta.state?.current;
        if (state === 'complete') finish(null);
        else if (state === 'interrupted') finish(new Error(delta.error?.current || 'Download interrupted'));
    }
    downloads.onChanged.addListener(changed);
    try {
        id = await downloads.download(options);
        for (const delta of early) changed(delta);
        // Catch completion that happened before download() returned its ID.
        const items = await downloads.search({ id });
        if (!items.length) throw new Error('Download no longer exists. Cached data has been retained.');
        changed({ id, state: { current: items[0].state }, error: { current: items[0].error } });
        const error = await completion;
        if (error) throw error;
        return true;
    } finally {
        downloads.onChanged.removeListener(changed);
    }
}
