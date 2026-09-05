export const DOWNLOAD_DB_NAME = "getv-downloads";
export const DOWNLOAD_DB_VERSION = 2;

export function openDownloadDB(factory = globalThis.indexedDB) {
    if (!factory) return Promise.reject(new Error(t("indexeddb_unsupported")));
    return new Promise((resolve, reject) => {
        const request = factory.open(DOWNLOAD_DB_NAME, DOWNLOAD_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "id" });
            if (!db.objectStoreNames.contains("segments")) {
                const segments = db.createObjectStore("segments", { keyPath: "id" });
                segments.createIndex("taskId", "taskId");
            }
            if (!db.objectStoreNames.contains("outputs")) {
                const outputs = db.createObjectStore("outputs", { keyPath: "id" });
                outputs.createIndex("taskId", "taskId");
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(t("database_open_failed")));
    });
}

export async function storePut(name, value, factory) {
    const db = await openDownloadDB(factory);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(name, "readwrite");
        transaction.objectStore(name).put(value);
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error || new Error(t("store_write_failed", name)));
        transaction.onabort = () => reject(transaction.error || new Error(t("store_write_aborted", name)));
    });
}

export async function storeAll(name, factory) {
    const db = await openDownloadDB(factory);
    return new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(t("store_read_failed", name)));
    });
}

export async function storeDelete(name, key, factory) {
    const db = await openDownloadDB(factory);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(name, "readwrite");
        transaction.objectStore(name).delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error(t("store_delete_failed", name)));
        transaction.onabort = () => reject(transaction.error || new Error(t("store_delete_aborted", name)));
    });
}

export async function taskParts(storeName, taskId, factory) {
    const db = await openDownloadDB(factory);
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).index("taskId").getAll(taskId);
        request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
        request.onerror = () => reject(request.error || new Error(t("store_read_failed", storeName)));
    });
}

export async function clearTaskParts(storeName, taskId, factory) {
    const db = await openDownloadDB(factory);
    const items = await taskParts(storeName, taskId, factory);
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        for (const item of items) transaction.objectStore(storeName).delete(item.id);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error(t("store_clear_failed", storeName)));
    });
}

export function createQueuedTask(job, id = crypto.randomUUID(), createdAt = Date.now()) {
    return {
        ...job,
        id,
        createdAt,
        state: "queued",
        completedSegments: 0,
        totalSegments: 0,
        bytes: 0,
        speed: 0
    };
}
import { t } from "./i18n.js";
