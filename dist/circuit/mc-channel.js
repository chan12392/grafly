// Pin one verified channel version for this process. Updates apply on the next CLI
// invocation; a running query never mixes old/new rules. No network here.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinRuntime } from '../mc-runtime/runtime.js';
const pinned = pinRuntime();
const managed = pinned && !pinned.error && pinned.metadata.provided_channels.includes('symbol_disambiguation');
const uri = managed ? pathToFileURL(join(pinned.root, 'morecoffee/channels/portable/symbol_disambiguation.mjs')).href
    : new URL('./mc/symbol_disambiguation.mjs', import.meta.url).href;
const channel = await import(uri);
if (channel.ARTIFACT?.schema !== 'mc.symbol_disambiguation.v1' || channel.ARTIFACT.channel_id !== 'symbol_disambiguation' ||
    (managed && channel.ARTIFACT.channel_version !== pinned.metadata.channels.symbol_disambiguation?.version))
    throw new Error('mc_symbol_channel_contract');
export const SYMBOL_CHANNEL = Object.freeze({ channel_id: channel.ARTIFACT.channel_id, version: channel.ARTIFACT.channel_version,
    source: managed ? 'signed-runtime' : 'packaged', runtimeVersion: managed ? pinned.metadata.version : null,
    get model_sha256() { return process.env.GRAFLY_WEIGHTS ? null : channel.MODEL_SHA256 || null; } });
export const { rankFeatures, DEFAULT_WEIGHTS, FEATURE_KEYS, ARTIFACT } = channel;
export const MODEL_SHA256 = channel.MODEL_SHA256 || null;
