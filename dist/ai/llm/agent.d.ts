import type { ChatModel, ChatRequest, ChatResponse } from './types.js';
export interface AgentContext { agent: 'codex' | 'claude'; home: string; }
export declare function agentContext(agent?: string, env?: NodeJS.ProcessEnv): AgentContext | null;
export declare class AgentChatModel implements ChatModel {
    constructor(context: AgentContext, env?: NodeJS.ProcessEnv);
    readonly label: string;
    readonly model: string;
    create(req: ChatRequest): Promise<ChatResponse>;
}
