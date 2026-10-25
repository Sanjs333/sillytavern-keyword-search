import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetStore, replaceText } from '../safe-data.js';

export function fixture() {
    const regex = { id: 'same-id', scriptName: 'Preserved regex', findRegex: '/old/g', replaceString: '<div>$1 {{match}}</div>', disabled: true };
    const live = { preset_settings_openai: 'A', temperature: 0.7, prompts: [{ identifier: 'main', content: 'old old' }, { identifier: 'other', content: 'untouched' }], prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }] }], extensions: { regex_scripts: [regex], custom: { live: 'keep' } } };
    const stored = structuredClone(live);
    stored.extensions.custom.disk = 'keep';
    stored.unknownMetadata = 'preserve';
    const writes = [];
    let selected = 'A', fail = false, settingsSaves = 0;
    const manager = { apiId: 'openai', getSelectedPresetName: () => selected, getCompletionPresetByName: () => stored,
        updatePreset() { throw new Error('unsafe generic API must never be used'); },
        async savePreset(name, data, options) { if (fail) throw new Error('offline'); writes.push({ name, data, options }); } };
    const context = { chatCompletionSettings: live, getPresetManager: () => manager, saveSettingsDebounced() { settingsSaves++; } };
    // Deliberately omit extensions and unknown metadata, as a compatibility test.
    const serializer = s => ({ prompts: s.prompts, prompt_order: s.prompt_order, temperature: s.temperature });
    const store = createPresetStore({ getContext: () => context, loadOpenAI: async () => ({ getChatCompletionPreset: serializer }) });
    function targets() { const binding = store.capture(); return [{ source: 'preset', presetBinding: binding, presetIndex: 0, key: 'main', text: live.prompts[0].content }]; }
    return { live, stored, manager, context, store, writes, targets, serializer, switchPreset: () => { selected = 'B'; }, fail: () => { fail = true; }, get settingsSaves() { return settingsSaves; } };
}

test('replacement saves an explicit complete preset and preserves bound regexes', async () => {
    const f = fixture(); const regex = structuredClone(f.live.extensions.regex_scripts);
    assert.equal((await f.store.replaceTargets(f.targets(), 'old', 'new', {})).done, 2);
    assert.equal(f.writes.length, 1);
    const write = f.writes[0];
    assert.equal(write.name, 'A'); assert.deepEqual(write.options, { skipUpdate: true });
    assert.equal(write.data.prompts[0].content, 'new new'); assert.equal(write.data.prompts[1].content, 'untouched');
    assert.deepEqual(write.data.extensions.regex_scripts, regex);
    assert.deepEqual(write.data.prompt_order, f.live.prompt_order);
    assert.deepEqual(write.data.extensions.custom, { live: 'keep', disk: 'keep' });
    assert.equal(write.data.unknownMetadata, 'preserve'); assert.equal(f.settingsSaves, 1);
    assert.deepEqual(f.stored, write.data);
});

test('saving before switching preserves regexes without generic updatePreset', async () => {
    const f = fixture(); await f.store.saveCurrent(); assert.deepEqual(f.writes[0].data.extensions.regex_scripts, f.live.extensions.regex_scripts);
});

test('serializer that returns {} cannot erase an otherwise complete stored preset', async () => {
    const f = fixture(); const store = createPresetStore({ getContext: () => f.context, loadOpenAI: async () => ({ getChatCompletionPreset: () => ({}) }) });
    await assert.rejects(store.saveCurrent(), /序列化/); assert.equal(f.writes.length, 0);
});

test('missing body/order in all sources aborts before saving', async () => {
    const f = fixture(); delete f.live.prompt_order; delete f.stored.prompt_order;
    await assert.rejects(f.store.saveCurrent(), /缺少/); assert.equal(f.writes.length, 0);
});

test('failed save does not mutate live or cached prompts or regexes', async () => {
    const f = fixture(), before = structuredClone(f.live), cached = structuredClone(f.stored); f.fail();
    await assert.rejects(f.store.replaceTargets(f.targets(), 'old', 'new', {}), /offline/);
    assert.deepEqual(f.live, before); assert.deepEqual(f.stored, cached); assert.equal(f.settingsSaves, 0);
});

test('switch after preview is rejected', async () => {
    const f = fixture(), targets = f.targets(); f.switchPreset();
    await assert.rejects(f.store.replaceTargets(targets, 'old', 'new', {}), /切换|变化/); assert.equal(f.writes.length, 0);
});

test('concurrent edit to bound regexes is rejected instead of overwritten', async () => {
    const f = fixture(), targets = f.targets(); f.live.extensions.regex_scripts[0].replaceString = 'new draft';
    await assert.rejects(f.store.replaceTargets(targets, 'old', 'new', {}), /变化/); assert.equal(f.writes.length, 0);
});

test('regexes omitted from live settings are preserved from the saved preset', async () => {
    const f = fixture(), scripts = structuredClone(f.stored.extensions.regex_scripts); delete f.live.extensions.regex_scripts;
    await f.store.saveCurrent(); assert.deepEqual(f.writes[0].data.extensions.regex_scripts, scripts);
});

test('explicit empty regex array is respected', async () => {
    const f = fixture(); f.live.extensions.regex_scripts = []; await f.store.saveCurrent(); assert.deepEqual(f.writes[0].data.extensions.regex_scripts, []);
});

test('plain-text replacement preserves dollar tokens and macros', () => {
    assert.deepEqual(replaceText('old old', 'old', '$1 $& {{match}}', {}), { value: '$1 $& {{match}} $1 $& {{match}}', count: 2 });
});

test('regex replacement supports captures', () => {
    assert.equal(replaceText('old42', 'old(\\d+)', 'new$1', { regex: true }).value, 'new42');
});

test('literal search escapes metacharacters', () => {
    assert.equal(replaceText('[old].*', '[old].*', 'new', {}).value, 'new');
});
