export type ModelTask = 'symbol_disambiguation' | 'patch_quality' | 'document_suitability' | 'tool_call_suitability' | 'input_block_retention';
export interface ModelIdentity { model_sha256: string; dataset_sha256: string }
export interface ModelRelease {
  schema: 'mc.model.release.v1'; sequence: number; sha256: string; bytes: number;
  runtime_api_min: number; model_schema: string; policy: string; scorer_version: string;
  source_runtime_sha256: string; published_at: string;
  models: Record<ModelTask, ModelIdentity | null>; revoked_model_sha256: string[];
}
export interface ModelBundle extends Omit<ModelRelease, 'schema' | 'sequence' | 'sha256' | 'bytes' | 'published_at' | 'models'> {
  schema: 'mc.model.bundle.v1'; models: Record<ModelTask, { sha256: string; content: string } | null>;
}
export interface PinnedModelRuntime { root: string; python: string; metadata: Record<string, unknown> }
export interface ModelStatus {
  status: string; home?: string; reason?: string; checked_at?: string;
  sequence?: number; bundle_sha256?: string; revocation_sequence?: number | null;
  models?: Record<ModelTask, ModelIdentity | null> | null; last_check?: unknown;
}
export declare const MODEL_MAX_BYTES: number;
export declare const MODEL_TASKS: readonly ModelTask[];
export declare function modelHome(env?: NodeJS.ProcessEnv): string;
export declare function verifyModelEnvelope(envelope: unknown, config: { publicKey: string }): ModelRelease;
export declare function verifyModelBundle(bytes: Buffer, metadata: ModelRelease): ModelBundle;
export declare function validateModelBundle(bytes: Buffer, pinned: PinnedModelRuntime): void;
export declare function syncModels(runtime?: string, options?: {
  home?: string; transport?: typeof fetch; validate?: typeof validateModelBundle;
}): Promise<ModelStatus>;
export declare function modelStatus(runtime?: string, home?: string): ModelStatus;
