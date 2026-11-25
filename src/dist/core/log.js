"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivityLog = void 0;
/** 内存环形日志，最多保留 500 条 */
class ActivityLog {
    items = [];
    seq = 0;
    add(e) {
        this.items.push({ id: ++this.seq, time: new Date().toISOString(), ...e });
        if (this.items.length > 500)
            this.items.splice(0, this.items.length - 500);
    }
    list(since = 0) {
        return this.items.filter((i) => i.id > since);
    }
}
exports.ActivityLog = ActivityLog;
