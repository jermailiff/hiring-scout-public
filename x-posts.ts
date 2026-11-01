import type { Page } from "playwright-core";

export interface PostEvidence {
  id: string;
  url: string;
  author: string;
  authorLabel: string;
  text: string;
  postedAt: string | null;
  truncated: boolean;
  links: { url: string; label: string; expandedUrl: string | null }[];
}

export interface PostReference {
  url: string | null;
  relationship: "quoted_post" | "linked_post" | "referenced_post";
  post?: PostEvidence;
}

export interface Post extends PostEvidence {
  // Must come from explicit source relationship evidence, never thread ordering.
  // The current reader does not populate this field yet.
  replyTo?: { postId: string; verified: boolean };
  references?: PostReference[];
  hiringContext?: {
    status: "resolved";
    relationship: PostReference["relationship"];
    referenceUrl: string | null;
    source: PostEvidence;
  } | {
    status: "unavailable" | "budget_skipped";
    relationship: PostReference["relationship"];
    referenceUrl: string | null;
  };
  discoveredInThread?: string;
  expansion?: "expanded" | "already_full" | "unavailable" | "budget_skipped";
}

// These are retrieval clues, not a claim that a job actually exists.
export function hiringSignals(post: Pick<Post, "text" | "links">): string[] {
  const signals = [
    ["hiring", /\bhiring\b/i],
    ["jobs", /\bjobs\b|\bjob\s+(?:openings?|opportunities|vacanc(?:y|ies))\b/i],
    ["careers", /\bcareers?\b/i],
    ["open_roles", /\b(?:open(?:ing)?|available)\s+(?:roles?|positions?|opportunities)\b/i],
    ["join_team", /\bjoin\s+(?:our|the|my)\s+team\b/i],
    ["recruiting", /\brecruiting\b/i],
  ] as const;
  const result = signals.filter(([, pattern]) => pattern.test(post.text)).map(([name]) => String(name));
  if (post.links.some(link => /careers?|\/jobs(?:\/|$)|jobs\.|ashbyhq\.com|greenhouse\.io|lever\.co/i.test(`${link.expandedUrl ?? link.url} ${link.label}`))) {
    result.push("careers_link");
  }
  return result;
}

export async function readPosts(page: Page, threadRoot?: string, rootAlreadySeen = false): Promise<Post[]> {
  const cards = await page.locator('article[data-testid="tweet"]').evaluateAll(articles => {
    const boundary = [...document.querySelectorAll('h2, [role="heading"]')]
      .find(node => /^(discover more|more posts|you might like)$/i.test(node.textContent?.trim() ?? ""));
    return articles.filter(article => !boundary || !(boundary.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map(article => {
        const statusUrl = (href: string | null): string | null => {
          if (!href) return null;
          try {
            const url = new URL(href, "https://x.com");
            const match = url.pathname.match(/^\/(\w+)\/status\/(\d+)(?:\/history)?\/?$/);
            return /^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname) && match
              ? `https://x.com/${match[1]}/status/${match[2]}` : null;
          } catch { return null; }
        };
        const owned = (node: Element, scope: Element): boolean => {
          const quote = node.closest('[role="link"]');
          return !quote || quote === scope || !scope.contains(quote);
        };
        const read = (scope: Element, isQuote = false): PostEvidence => {
          const time = [...scope.querySelectorAll("time")].find(node => owned(node, scope)
            && statusUrl(node.closest("a")?.getAttribute("href") ?? null));
          const explicitQuoteLink = isQuote ? statusUrl(scope.getAttribute("href"))
            ?? [...scope.querySelectorAll('a[href]')].filter(node => owned(node, scope))
              .map(node => statusUrl(node.getAttribute("href"))).find(Boolean) : null;
          const url = statusUrl(time?.closest("a")?.getAttribute("href") ?? null) ?? explicitQuoteLink ?? "";
          const match = url.match(/\/(\w+)\/status\/(\d+)$/);
          const textNode = [...scope.querySelectorAll('[data-testid="tweetText"]')]
            .find(node => owned(node, scope)) as HTMLElement | undefined;
          const textLinks = [...(textNode?.querySelectorAll('a[href]') ?? [])];
          const cardLinks = [...scope.querySelectorAll('[data-testid="card.wrapper"]')]
            .filter(node => owned(node, scope))
            .map(card => card.closest('a[href]') ?? card.querySelector('a[href]'))
            .filter((node): node is Element => node !== null);
          const links = [...new Set([...textLinks, ...cardLinks])]
            .map(node => ({
              url: node.getAttribute("href") ?? "",
              label: node.textContent?.trim()
                || node.closest('[data-testid="card.wrapper"]')?.textContent?.trim()
                || node.querySelector('[data-testid="card.wrapper"]')?.textContent?.trim() || "",
              expandedUrl: /^https?:\/\//.test(node.getAttribute("title") ?? "") ? node.getAttribute("title") : null,
            }))
            .filter(link => /^https?:\/\//.test(link.url) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(link.url));
          const name = [...scope.querySelectorAll('[data-testid="User-Name"]')]
            .find(node => owned(node, scope)) as HTMLElement | undefined;
          return {
            id: match?.[2] ?? "", url, author: match?.[1] ?? "", authorLabel: name?.innerText ?? "",
            text: textNode?.innerText ?? "", postedAt: time?.getAttribute("datetime") ?? null,
            truncated: [...scope.querySelectorAll('[data-testid="tweet-text-show-more-link"]')]
              .some(node => owned(node, scope)),
            links: [...new Map(links.map(link => [link.url, link])).values()],
          };
        };
        const main = read(article);
        const references: PostReference[] = [];
        // Preserve the quote's own identity and date, never merge it into main.text.
        for (const quote of article.querySelectorAll('[role="link"]')) {
          if (quote.parentElement?.closest('[role="link"]')) continue;
          const post = read(quote, true);
          if ((post.id || post.text.trim()) && post.id !== main.id) {
            references.push({ url: post.url || null, relationship: "quoted_post", post });
            break; // At most one quote; no nested traversal.
          }
        }
        const mainText = [...article.querySelectorAll('[data-testid="tweetText"]')]
          .find(node => owned(node, article));
        for (const link of mainText?.querySelectorAll('a[href]') ?? []) {
          const url = statusUrl(link.getAttribute("title")) ?? statusUrl(link.getAttribute("href"));
          if (url && url !== main.url && !references.some(ref => ref.url === url)) {
            references.push({ url, relationship: "linked_post" });
          }
        }
        return { ...main, ...(references.length ? { references } : {}) };
      });
  });
  const rootIndex = threadRoot ? cards.findIndex(card => card.id === threadRoot) : -1;
  // Only inspect conversation cards following the selected root; omit preceding ancestors.
  const selected = threadRoot ? rootIndex < 0 ? rootAlreadySeen ? cards : [] : cards.slice(rootIndex + 1) : cards;
  return selected.filter(card => card.id && (card.text.trim() || card.links.length)).map(card => ({
    ...card,
    url: `https://x.com/${card.author}/status/${card.id}`,
    ...(threadRoot ? { discoveredInThread: threadRoot } : {}),
  }));
}
