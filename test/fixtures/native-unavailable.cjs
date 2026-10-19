const Module = require('node:module');
const original = Module._load;
const blocked = new Set((process.env.GRAFLY_TEST_MISSING_NATIVE ?? '').split(','));
Module._load = function (name, ...args) {
    if (blocked.has(name)) throw new Error(`fixture: unavailable ${name}`);
    return original.call(this, name, ...args);
};
