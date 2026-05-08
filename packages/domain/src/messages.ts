import { z } from 'zod';

export const ImageSource = z.union([
  z.object({ kind: z.literal('url'), url: z.string().url(), mediaType: z.string().optional() }),
  z.object({ kind: z.literal('base64'), data: z.string(), mediaType: z.string() }),
]);
export type ImageSource = z.infer<typeof ImageSource>;

export const ContentBlock: z.ZodType<ContentBlockType> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), source: ImageSource }),
    z.object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    }),
    z.object({
      type: z.literal('tool_result'),
      toolUseId: z.string(),
      content: z.array(ContentBlock),
      isError: z.boolean().optional(),
    }),
  ]),
);

export type ContentBlockType =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; toolUseId: string; content: ContentBlockType[]; isError?: boolean };

export const Role = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof Role>;

export const SystemMessage = z.object({
  role: z.literal('system'),
  content: z.array(ContentBlock),
  cache: z.literal('ephemeral').optional(),
});

export const UserMessage = z.object({
  role: z.literal('user'),
  content: z.array(ContentBlock),
});

export const AssistantMessage = z.object({
  role: z.literal('assistant'),
  content: z.array(ContentBlock),
  thinking: z.array(ContentBlock).optional(),
});

export const ToolMessage = z.object({
  role: z.literal('tool'),
  toolUseId: z.string(),
  content: z.array(ContentBlock),
  isError: z.boolean().optional(),
});

export const Message = z.discriminatedUnion('role', [
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
]);
export type Message = z.infer<typeof Message>;
