import type { PostToolInput } from './types.js';
export declare function handlePostTool(input: PostToolInput & {
    context_size_pct?: number;
}): Promise<{
    additionalContext: string;
} | null>;
//# sourceMappingURL=posttool-handler.d.ts.map