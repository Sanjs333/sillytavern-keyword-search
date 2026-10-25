import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetStore } from '../safe-data.js';
import { createRegexStore } from '../regex-data.js';

function fixture() {
    const script = name => ({ id: 'shared-id', scriptName: name, findRegex: '/old/g', replaceString: 'old $1 {{match}}', disabled: true, placement: [1, 2], minDepth: 0, trimStrings: ['keep'] });
    const global = [script('Global'), { ...script('Unselected global'), id: 'other', replaceString: 'unchanged' }];
    const char = [script('Character')];
    const preset = [script('Preset')];
    const live = { preset_settings_openai: 'A', prompts: [{ identifier: 'main', content: 'old prompt' }], prompt_order: [], extensions: { regex_scripts: preset, untouched: { keep: true } } };
    const stored = structuredClone(live), regexWrites = [], presetWrites = [];
    let selected = 'A', avatar = 'a.png', failType = -1;
    const character = { avatar, name: 'A character', data: { extensions: { regex_scripts: char } } };
    const context = { mainApi: 'openai', extensionSettings: { regex: global }, characterId: 0, characters: [character], chatCompletionSettings: live, saveSettingsDebounced() {} };
    const manager = { apiId: 'openai', getSelectedPresetName: () => selected, getCompletionPresetByName: () => stored, async savePreset(name, data, options) { presetWrites.push({ name, data, options }); } };
    context.getPresetManager = () => manager;
    const engine = { SCRIPT_TYPES: { GLOBAL: 0, PRESET: 2, SCOPED: 1 }, getCurrentPresetAPI: () => 'openai', getCurrentPresetName: () => selected,
        getScriptsByType(type) { return type === 0 ? context.extensionSettings.regex : type === 1 ? context.characters[0].data.extensions.regex_scripts : live.extensions.regex_scripts; },
        async saveScriptsByType(scripts, type) { if (type === failType) throw new Error('offline'); regexWrites.push({ scripts, type }); if (type === 0) context.extensionSettings.regex = scripts; else if (type === 1) context.characters[0].data.extensions.regex_scripts = scripts; else throw new Error('OpenAI preset regex must use complete safe preset save'); } };
    const presetStore = createPresetStore({ getContext: () => context, loadOpenAI: async () => ({ getChatCompletionPreset: s => structuredClone(s) }) });
    const regexStore = createRegexStore({ getContext: () => context, presetStore, loadEngine: async () => engine });
    return { global, char, preset, live, stored, context, engine, presetStore, regexStore, regexWrites, presetWrites,
        switchCharacter() { context.characters[0] = { avatar: 'b.png', name: 'B', data: { extensions: { regex_scripts: [script('B')] } } }; },
        switchPreset() { selected = 'B'; live.preset_settings_openai = 'B'; }, fail(type) { failType = type; } };
}
async function targets(f, scopes = { regexGlobal: true, regexPreset: true, regexCharacter: true }) {
    return (await f.regexStore.collect(scopes)).flatMap(g => g.items.filter(t => t.text.includes('old')));
}

test('all three regions are separately labeled despite duplicate script ids', async () => {
    const f = fixture(), groups = await f.regexStore.collect({ regexGlobal: true, regexPreset: true, regexCharacter: true });
    assert.deepEqual(groups.map(g => g.scope), ['global', 'preset', 'character']);
    assert.deepEqual(groups.flatMap(g => g.items.filter(t => t.text.includes('old'))).map(t => t.title), ['Global', 'Preset', 'Character']);
});

test('only selected global replaceString changes; all other script fields survive', async () => {
    const f = fixture(), before = structuredClone(f.global), chosen = await targets(f, { regexGlobal: true });
    assert.equal((await f.regexStore.replaceTargets(chosen, [], 'old', '$2 {{match}}', {})).done, 1);
    assert.deepEqual(f.regexWrites[0].scripts[0], { ...before[0], replaceString: '$2 {{match}} $1 {{match}}' });
    assert.deepEqual(f.regexWrites[0].scripts[1], before[1]); assert.equal(f.presetWrites.length, 0); assert.deepEqual(f.char[0].replaceString, 'old $1 {{match}}');
});

test('preset replacement preserves prompts, other extensions, and other regions', async () => {
    const f = fixture(), chosen = await targets(f, { regexPreset: true });
    await f.regexStore.replaceTargets(chosen, [], 'old', 'new', {});
    assert.equal(f.presetWrites.length, 1); assert.equal(f.regexWrites.length, 0);
    assert.equal(f.presetWrites[0].data.extensions.regex_scripts[0].replaceString, 'new $1 {{match}}');
    assert.equal(f.presetWrites[0].data.prompts[0].content, 'old prompt'); assert.deepEqual(f.presetWrites[0].data.extensions.untouched, { keep: true });
    assert.equal(f.global[0].replaceString, 'old $1 {{match}}'); assert.equal(f.char[0].replaceString, 'old $1 {{match}}');
});

test('prompt and preset regex replacement use one complete combined save', async () => {
    const f = fixture(), binding = f.presetStore.capture();
    const prompt = { source: 'preset', presetBinding: binding, presetIndex: 0, key: 'main', text: 'old prompt' };
    const chosen = await targets(f, { regexPreset: true });
    assert.equal((await f.regexStore.replaceTargets(chosen, [prompt], 'old', 'new', {})).done, 2);
    assert.equal(f.presetWrites.length, 1); assert.equal(f.presetWrites[0].data.prompts[0].content, 'new prompt');
    assert.equal(f.presetWrites[0].data.extensions.regex_scripts[0].replaceString, 'new $1 {{match}}');
});

test('all three regions save by their actual storage provider', async () => {
    const f = fixture(), chosen = await targets(f); assert.equal((await f.regexStore.replaceTargets(chosen, [], 'old', 'new', {})).done, 3);
    assert.deepEqual(f.regexWrites.map(w => w.type), [0, 1]); assert.equal(f.presetWrites.length, 1);
});

test('character switch after preview rejects the entire batch before writes', async () => {
    const f = fixture(), chosen = await targets(f); f.switchCharacter();
    await assert.rejects(f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}), /变化/); assert.equal(f.regexWrites.length + f.presetWrites.length, 0);
});

test('preset switch after preview does not write into the new preset', async () => {
    const f = fixture(), chosen = await targets(f); f.switchPreset();
    await assert.rejects(f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}), /变化|切换/); assert.equal(f.regexWrites.length + f.presetWrites.length, 0);
});

test('concurrent script edit after preview is not overwritten', async () => {
    const f = fixture(), chosen = await targets(f, { regexGlobal: true }); f.global[0].replaceString = 'someone else';
    await assert.rejects(f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}), /变化/); assert.equal(f.regexWrites.length, 0);
});

test('failure reports already saved regions without pretending complete success', async () => {
    const f = fixture(), chosen = await targets(f); f.fail(1);
    await assert.rejects(f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}), e => e.message === 'offline' && e.completed === 2);
    assert.equal(f.char[0].replaceString, 'old $1 {{match}}');
});

test('unsupported preset provider is not mapped onto global or scoped scripts', async () => {
    const f = fixture(); delete f.engine.SCRIPT_TYPES.PRESET;
    assert.equal((await f.regexStore.availability()).regexPreset, false);
    await assert.rejects(f.regexStore.collect({ regexPreset: true }), /不支持/); assert.equal(f.regexWrites.length, 0);
});

test('disabled scripts are searchable without being enabled', async () => {
    const f = fixture(), chosen = await targets(f, { regexCharacter: true }); assert.equal(chosen[0].disabled, true);
    await f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}); assert.equal(f.regexWrites[0].scripts[0].disabled, true);
});

test('missing character is skipped, not replaced with global scripts', async () => {
    const f = fixture(); f.context.characterId = undefined;
    assert.deepEqual(await f.regexStore.collect({ regexCharacter: true }), []);
});

test('non-OpenAI preset regex uses the native preset script provider', async () => {
    const f = fixture(); f.context.mainApi = 'textgenerationwebui';
    f.engine.getCurrentPresetAPI = () => 'textgenerationwebui';
    f.engine.saveScriptsByType = async (scripts, type) => f.regexWrites.push({ scripts, type });
    const chosen = await targets(f, { regexPreset: true });
    await f.regexStore.replaceTargets(chosen, [], 'old', 'new', {});
    assert.equal(f.presetWrites.length, 0); assert.equal(f.regexWrites[0].type, 2);
});

test('switching preset API during preview is rejected before any save', async () => {
    const f = fixture(), chosen = await targets(f, { regexPreset: true });
    f.engine.getCurrentPresetAPI = () => 'textgenerationwebui';
    await assert.rejects(f.regexStore.replaceTargets(chosen, [], 'old', 'new', {}), /变化/);
    assert.equal(f.presetWrites.length + f.regexWrites.length, 0);
});

test('regex captures work while existing macro and dollar tokens stay in source text', async () => {
    const f = fixture(), chosen = await targets(f, { regexGlobal: true });
    await f.regexStore.replaceTargets(chosen, [], '(old)', 'new-$1', { regex: true });
    assert.equal(f.regexWrites[0].scripts[0].replaceString, 'new-old $1 {{match}}');
});

test('empty replacement clears only matching text, not other regions', async () => {
    const f = fixture(), chosen = await targets(f, { regexGlobal: true });
    await f.regexStore.replaceTargets(chosen, [], 'old', '', {});
    assert.equal(f.regexWrites[0].scripts[0].replaceString, ' $1 {{match}}');
    assert.equal(f.preset[0].replaceString, 'old $1 {{match}}');
});

test('same ids repeated within a regex region are targeted by index', async () => {
    const f = fixture(); f.global[1] = { ...f.global[0], scriptName: 'Second', replaceString: 'old second' };
    const chosen = (await targets(f, { regexGlobal: true })).slice(1);
    await f.regexStore.replaceTargets(chosen, [], 'old', 'new', {});
    assert.equal(f.regexWrites[0].scripts[0].replaceString, 'old $1 {{match}}');
    assert.equal(f.regexWrites[0].scripts[1].replaceString, 'new second');
});
