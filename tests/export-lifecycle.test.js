import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../Shared (Extension)/Resources/manager.js', import.meta.url), 'utf8');
for (const kind of ['direct', 'hls']) test(`${kind}: do not clear cached bytes when Safari only starts saving`, async () => {
    const cleared = [];
    const listeners = new Set();
    const downloads = {
        download: async () => 7,
        search: async () => [{ id: 7, state: 'in_progress' }],
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    const context = vm.createContext({
        Blob, URL, setTimeout: () => 0, browser: { downloads }, deletedTaskIds: new Set(),
        taskSegments: async () => [{ blob: new Blob(['cached video bytes']) }],
        saveTask: async () => {}, clearTaskParts: async store => cleared.push(store),
        safeFilename: value => value, loadSettings: async () => ({ autoSave: true, clearCacheAfterSave: true }), t: key => key,
    });
    if (fs.existsSync(new URL('../Shared (Extension)/Resources/save-download.js', import.meta.url))) {
        const { saveDownload } = await import('../Shared (Extension)/Resources/save-download.js');
        context.saveDownload = options => saveDownload(options, downloads);
    }
    vm.runInContext(source.slice(source.indexOf('async function assemble(task,'), source.indexOf('async function transmuxTrackToMP4')), context);
    const task = { id: 'test', kind, filename: 'test.mp4', videoContainer: 'fmp4' };
    const saving = context.assemble(task, false);
    let settled = false;
    const result = saving.then(() => { settled = true; }, error => { settled = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'starting a Safari download must not report successful completion');
    assert.ok(!cleared.includes('segments'), 'cache must survive while Safari reads the Blob');
    for (const listener of listeners) listener({ id: 7, state: { current: 'interrupted' }, error: { current: 'WebKitBlobResource error 1' } });
    assert.match((await result).message, /WebKitBlobResource/);
    assert.ok(!cleared.includes('segments'));
    assert.notEqual(task.state, 'complete');
});

test('successful save waits for completion and removes its listener', async () => {
    const { saveDownload } = await import('../Shared (Extension)/Resources/save-download.js');
    const listeners = new Set();
    const downloads = {
        download: async () => 12,
        search: async () => [{ id: 12, state: 'in_progress' }],
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }
    };
    let done = false;
    const saving = saveDownload({ url: 'blob:test' }, downloads).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    for (const listener of listeners) listener({ id: 99, state: { current: 'complete' } });
    assert.equal(done, false);
    for (const listener of listeners) listener({ id: 12, state: { current: 'complete' } });
    await saving;
    assert.equal(done, true);
    assert.equal(listeners.size, 0);
});

test('completion before the download ID resolves is not lost', async () => {
    const { saveDownload } = await import('../Shared (Extension)/Resources/save-download.js');
    let listener;
    await saveDownload({ url: 'blob:test' }, {
        download: async () => { listener({ id: 4, state: { current: 'complete' } }); return 4; },
        search: async () => [{ id: 4, state: 'complete' }],
        onChanged: { addListener: fn => { listener = fn; }, removeListener: () => {} }
    });
});

test('Safari without download status APIs can still request a save', async () => {
    const { saveDownload } = await import('../Shared (Extension)/Resources/save-download.js');
    let requested;
    const result = await saveDownload({ url: 'blob:test', filename: 'test.mp4' }, {
        download: async options => { requested = options; return 3; }
    });
    assert.equal(requested.filename, 'test.mp4');
    assert.equal(result, false, 'an unobservable save must not authorize cache cleanup');
});

test('Safari without downloads API uses a connected download link', async () => {
    const { saveDownload } = await import('../Shared (Extension)/Resources/save-download.js');
    let connected = false;
    let clicked = false;
    const anchor = { click() { assert.ok(connected); clicked = true; }, remove() { connected = false; } };
    const document = { createElement: () => anchor, body: { append: () => { connected = true; } } };
    const result = await saveDownload({ url: 'blob:test', filename: 'test.mp4' }, undefined, document);
    assert.equal(clicked, true);
    assert.equal(anchor.download, 'test.mp4');
    assert.equal(result, false);
});

for (const kind of ['direct', 'hls']) test(`${kind}: unconfirmed saves retain cache and Blob URL`, async () => {
    const cleared = [];
    const revoked = [];
    const context = vm.createContext({
        Blob, URL: { createObjectURL: () => 'blob:retained', revokeObjectURL: url => revoked.push(url) },
        deletedTaskIds: new Set(), taskSegments: async () => [{ blob: new Blob(['cached bytes']) }],
        saveTask: async () => {}, clearTaskParts: async store => cleared.push(store),
        safeFilename: value => value, loadSettings: async () => ({ autoSave: true, clearCacheAfterSave: true }),
        t: key => key, requestExportCleanup: async () => false, saveDownload: async () => false
    });
    vm.runInContext(source.slice(source.indexOf('async function assemble(task,'), source.indexOf('async function transmuxTrackToMP4')), context);
    const task = { id: 'test', kind, filename: 'test.mp4', videoContainer: 'fmp4' };
    await context.assemble(task, false);
    assert.equal(task.saveUnconfirmed, true);
    assert.ok(!cleared.includes('segments'));
    assert.equal(revoked.length, 0);
});

for (const kind of ['direct', 'hls']) test(`${kind}: manual mode retains cache until an explicit save`, async () => {
    const cleared = [];
    const saves = [];
    const context = vm.createContext({
        Blob, URL, deleteTask: async () => {}, requestExportCleanup: async () => false, deletedTaskIds: new Set(),
        taskSegments: async () => [{ blob: new Blob(['cached bytes']) }],
        saveTask: async () => {}, clearTaskParts: async store => cleared.push(store),
        safeFilename: value => value,
        loadSettings: async () => ({ autoSave: false, clearCacheAfterSave: true }),
        t: key => key, saveDownload: async options => { saves.push(options); return true; }
    });
    vm.runInContext(source.slice(source.indexOf('async function assemble(task,'), source.indexOf('async function transmuxTrackToMP4')), context);
    let task = { id: 'manual', kind, filename: 'test.mp4', videoContainer: 'fmp4', state: 'running' };
    await context.finishDownload(task);
    assert.equal(task.state, 'complete');
    assert.equal(task.awaitingSave, true);
    assert.equal(saves.length, 0);
    assert.deepEqual(cleared, []);
    // Persisted tasks must remain exportable after reopening the manager.
    task = JSON.parse(JSON.stringify(task));
    await context.assemble(task, false);
    assert.equal(saves.length, 1);
    assert.equal(task.awaitingSave, false);
    assert.ok(!cleared.includes('segments'), 'cache cleanup requires confirmation');
});

for (const kind of ['direct', 'hls']) test(`${kind}: auto-save still exports on download completion`, async () => {
    let saves = 0;
    const context = vm.createContext({
        Blob, URL, deleteTask: async () => {}, requestExportCleanup: async () => false, deletedTaskIds: new Set(),
        taskSegments: async () => [{ blob: new Blob(['cached bytes']) }],
        saveTask: async () => {}, clearTaskParts: async () => {}, safeFilename: value => value,
        loadSettings: async () => ({ autoSave: true }), t: key => key,
        saveDownload: async () => { saves++; return true; }
    });
    vm.runInContext(source.slice(source.indexOf('async function assemble(task,'), source.indexOf('async function transmuxTrackToMP4')), context);
    const task = { id: 'auto', kind, filename: 'test.mp4', videoContainer: 'fmp4', state: 'running' };
    await context.finishDownload(task);
    assert.equal(saves, 1);
    assert.equal(task.state, 'complete');
    assert.equal(task.awaitingSave, false);
});

for (const kind of ['direct', 'hls']) {
    for (const scenario of ['accept', 'cancel', 'unconfirmed', 'unconfirmed_accept', 'partial']) {
        test(`${kind}: export cleanup ${scenario}`, async () => {
            const cleared = [];
            const removed = [];
            let prompts = 0;
            const task = { id: 'cleanup', kind, filename: 'video.mp4', videoContainer: 'fmp4', state: 'complete' };
            const context = vm.createContext({
                Blob, URL, tasks: [task], active: new Map(), deletedTaskIds: new Set(),
                taskSegments: async () => [{ blob: new Blob(['cached bytes']) }],
                saveTask: async () => {}, clearTaskParts: async store => cleared.push(store),
                storeDelete: async (store, id) => removed.push([store, id]), render: () => {},
                safeFilename: value => value, loadSettings: async () => ({ autoSave: false, clearCacheAfterSave: true }),
                t: key => key, saveDownload: async () => !scenario.startsWith('unconfirmed'),
                requestExportCleanup: async (task, filename, confirmed) => { assert.equal(confirmed, !scenario.startsWith('unconfirmed')); prompts++; return ['accept', 'unconfirmed_accept'].includes(scenario); },
                confirm: () => assert.fail('must not show a second native confirmation'),
                alert: message => assert.fail(message)
            });
            vm.runInContext(source.slice(source.indexOf('async function assemble(task,'), source.indexOf('async function transmuxTrackToMP4')), context);
            vm.runInContext(source.slice(source.indexOf('async function deleteTask('), source.indexOf('async function clearAllTasks(')), context);
            await context.assemble(task, scenario === 'partial');
            assert.equal(prompts, scenario === 'partial' ? 0 : 1);
            if (['accept', 'unconfirmed_accept'].includes(scenario)) {
                assert.ok(cleared.includes('segments'));
                assert.ok(cleared.includes('outputs'));
                assert.deepEqual(removed, [['tasks', 'cleanup']]);
                assert.equal(context.tasks.length, 0);
                assert.ok(context.deletedTaskIds.has(task.id));
            } else {
                assert.ok(!cleared.includes('segments'));
                assert.deepEqual(removed, []);
                assert.equal(context.tasks.length, 1);
            }
        });
    }
}

for (const action of ['keep', 'delete', 'escape']) test(`page export dialog: ${action}`, async () => {
    let shown;
    const document = {
        body: { append: node => { shown = node; } },
        createElement: tag => ({
            tag, children: [], listeners: {},
            append(...children) { this.children.push(...children); },
            addEventListener(name, listener) { this.listeners[name] = listener; },
            showModal() { this.open = true; },
            close() { this.open = false; this.listeners.close(); },
            focus() { this.focused = true; },
            remove() { this.removed = true; }
        })
    };
    const context = vm.createContext({ document, deletedTaskIds: new Set(), t: key => key });
    vm.runInContext(source.slice(source.indexOf('function requestExportCleanup('), source.indexOf('function statusText(')), context);
    const pending = context.requestExportCleanup({ id: 'test' }, 'video.mp4', false);
    assert.equal(shown.open, true);
    assert.equal(shown.children[1].textContent, 'export_unconfirmed_cleanup');
    const [keep, remove] = shown.children[2].children;
    assert.equal(keep.focused, true);
    if (action === 'escape') shown.close();
    else (action === 'delete' ? remove : keep).listeners.click();
    assert.equal(await pending, action === 'delete');
    assert.equal(shown.removed, true);
});
