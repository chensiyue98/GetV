import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../Shared (Extension)/Resources/manager.js', import.meta.url), 'utf8');
function element() {
    const fields = new Map();
    return { dataset: {}, style: {}, children: [],
        querySelector(key) { if (!fields.has(key)) fields.set(key, element()); return fields.get(key); },
        addEventListener(type, fn) { this['on' + type] = fn; },
        replaceChildren() { this.children = []; },
        append(node) { this.children = this.children.filter(item => item !== node); this.children.push(node); },
        insertBefore(node, before) { this.children = this.children.filter(item => item !== node); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, node); }, appendChild(node) { this.append(node); }, remove() {}, cloneNode: element
    };
}
test('download progress preserves the Rename button between pointer down and click', () => {
    const document = element();
    document.querySelector('#task-template').content = { firstElementChild: element() };
    const task = { id: 'running', kind: 'direct', state: 'running', filename: 'video.mp4', bytes: 1 };
    let prompts = 0;
    const context = vm.createContext({ document, tasks: [task], t: key => key,
        formatBytes: String, formatDuration: String, prompt: () => { prompts++; return null; }
    });
    vm.runInContext(source.slice(source.indexOf('function statusText('), source.indexOf('async function migrateLegacyPendingJobs')), context);
    context.render();
    const pressed = document.querySelector('#task-list').children[0].querySelector('[data-action="rename"]');
    task.bytes = 2;
    context.render();
    const released = document.querySelector('#task-list').children[0].querySelector('[data-action="rename"]');
    assert.equal(pressed, released, 'progress must not replace the pressed button before the click event');
    released.onclick();
    assert.equal(prompts, 1);
});
