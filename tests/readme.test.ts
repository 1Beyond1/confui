import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubReadme, readLocalReadme } from "../core/inference/readme.ts";

const README_MAX_BYTES = 512 * 1024;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GitHub README loading", () => {
  it("deduplicates and caches public README requests during a session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("# Cached README"));
    const repository = "https://github.com/confui-tests/public-readme-cache";

    const [first, second] = await Promise.all([
      fetchGithubReadme(repository, undefined, fetcher),
      fetchGithubReadme(repository, undefined, fetcher),
    ]);

    expect(first).toBe("# Cached README");
    expect(second).toBe("# Cached README");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/confui-tests/public-readme-cache/readme",
      expect.objectContaining({ redirect: "error" }),
    );

    await fetchGithubReadme(repository, undefined, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not reuse authenticated README responses across requests", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response("first"))
      .mockImplementationOnce(async () => new Response("second"));
    const repository = "https://github.com/confui-tests/private-readme-cache";

    await expect(fetchGithubReadme(repository, "token-one", fetcher)).resolves.toBe("first");
    await expect(fetchGithubReadme(repository, "token-two", fetcher)).resolves.toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not treat a lookalike GitHub host as a repository", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(fetchGithubReadme("https://github.com.attacker.example/owner/repo", undefined, fetcher))
      .rejects.toThrow("GitHub 仓库链接格式不正确");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept credentials embedded in a GitHub URL", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(fetchGithubReadme("https://user:password@github.com/owner/repo", undefined, fetcher))
      .rejects.toThrow("GitHub 仓库链接格式不正确");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads only a 512 KiB UTF-8-safe prefix from an oversized local README", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-readme-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "README.md"),
      Buffer.concat([Buffer.alloc(README_MAX_BYTES - 1, "a"), Buffer.from("你tail", "utf8")]),
    );

    const text = await readLocalReadme(root);

    expect(text).toBe("a".repeat(README_MAX_BYTES - 1));
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThanOrEqual(README_MAX_BYTES);
  });

  it("cancels an oversized remote README stream after retaining its UTF-8-safe prefix", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(README_MAX_BYTES - 1, "a"));
        controller.enqueue(Buffer.from("你tail", "utf8"));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));

    const text = await fetchGithubReadme(
      "https://github.com/confui-tests/oversized-remote-readme",
      "uncached-test-token",
      fetcher,
    );

    expect(text).toBe("a".repeat(README_MAX_BYTES - 1));
    expect(text).not.toContain("�");
    expect(canceled).toBe(true);
  });
});
