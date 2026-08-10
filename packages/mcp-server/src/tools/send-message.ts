import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

/**
 * Mark a Flex message as a test send without changing what is being tested.
 *
 * A test send exists to show the real thing, so the banner is added *around*
 * the message: every other property of the bubble — hero image, styles, size —
 * is carried through untouched. The previous version rebuilt the bubble from
 * body + footer alone, which silently dropped the hero and made the preview a
 * lie; it also used the 3-digit colour `#333`, which LINE rejects outright
 * (`invalid property /header/contents/0/color`), so no Flex test send worked
 * at all. Colours here must be #RRGGBB or #RRGGBBAA.
 */
function withTestBanner(flex: Record<string, unknown>): Record<string, unknown> {
  const banner = {
    type: "text",
    text: "⚠️ テスト配信",
    size: "sm",
    weight: "bold",
    color: "#333333",
    align: "center",
    wrap: true,
  };
  const header = {
    type: "box",
    layout: "vertical",
    backgroundColor: "#FFE066",
    paddingAll: "8px",
    contents: [banner],
  };

  if (flex.type === "carousel" && Array.isArray(flex.contents)) {
    // Carousels have no header of their own — banner every bubble, so the
    // marking survives however far the reviewer swipes.
    return {
      ...flex,
      contents: flex.contents.map((bubble) =>
        bubble && typeof bubble === "object"
          ? withTestBanner(bubble as Record<string, unknown>)
          : bubble,
      ),
    };
  }

  const existing = flex.header as { contents?: unknown } | undefined;
  if (existing && typeof existing === "object" && Array.isArray(existing.contents)) {
    // Keep the message's own header; the banner just goes on top of it.
    return { ...flex, header: { ...existing, contents: [banner, ...existing.contents] } };
  }

  return { ...flex, header };
}

export function registerSendMessage(server: McpServer): void {
  server.tool(
    "send_message",
    "Send a text, image, or flex message to a specific friend. Use messageType 'image' for standalone image messages, 'flex' for rich card layouts.",
    {
      friendId: z.string().describe("The friend's ID to send the message to"),
      content: z
        .string()
        .describe(
          "Message content. For text: plain string. For image: JSON string with originalContentUrl and previewImageUrl (both HTTPS URLs). For flex: JSON string of LINE Flex Message.",
        ),
      messageType: z
        .enum(["text", "image", "flex"])
        .default("text")
        .describe(
          "Message type: 'text' for plain text, 'image' for standalone image, 'flex' for Flex Message JSON",
        ),
      altText: z
        .string()
        .optional()
        .describe(
          "Custom notification preview text for Flex Messages (shown on lock screen). If omitted, auto-extracted from Flex content.",
        ),
      isTest: z
        .boolean()
        .default(false)
        .describe(
          "Mark as test send. Prepends 【テスト配信】 to text messages, adds test banner to flex messages.",
        ),
      trackLinks: z
        .boolean()
        .default(true)
        .describe(
          "Set false to disable automatic URL shortening (/t/ tracking links). URLs are sent as-is. Default true.",
        ),
    },
    async ({ friendId, content, messageType, altText, isTest, trackLinks }) => {
      try {
        const client = getClient();

        // Add test label
        let finalContent = content;
        if (isTest) {
          if (messageType === "text") {
            finalContent = `【テスト配信】\n${content}`;
          } else if (messageType === "flex") {
            try {
              finalContent = JSON.stringify(withTestBanner(JSON.parse(content)));
            } catch {
              finalContent = content;
            }
          }
        }

        // URL の短縮 (auto-track) は worker が送信時に行う (friend の所属アカウント
        // 付きでリンクを所有させるため、ここでは変換しない)。trackLinks=false は
        // API に渡して worker 側の短縮もスキップさせる。
        const result = await client.friends.sendMessage(
          friendId,
          finalContent,
          messageType,
          altText,
          { trackLinks },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, messageId: result.messageId },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: String(error) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
