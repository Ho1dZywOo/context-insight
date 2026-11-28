// 工作台「导出 → 原始文件 (zip)」旅程（真实服务 + 真实库 + 真实盘上原件）：
// 页头导出菜单打开即查归档计划，「原始文件」条目照实写明几个会话按原文件 →
// 点击下载 context_session_*.zip → 7za 独立解包：原文件逐字节与盘上原件一致、
// 包根 export-manifest.json 记明会话与文件；bundle 形态下条目文案与计划端点
// 逐字对得上（所见即所得），全员成员都进清单。
// 语料：solo = claude-sample（源文件 tests/ut/data/e2e/claude-sample.jsonl）；
// bundle = minidemo01（三成员）。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sevenzipBin from "7zip-bin";
import { expect, test, type Page } from "./fixtures";
import { BASE_URL, CLAUDE_SAMPLE_SESSION_ID, E2E_RUN_ID, REPO_ROOT } from "./constants";
import { RunWorkbenchPO } from "./support/pom/RunWorkbenchPO";
import { stripFilePicker } from "./support/file-picker";

const SOLO_MAIN = `sessions/${CLAUDE_SAMPLE_SESSION_ID}/claude-sample.jsonl`;
const SOLO_FIXTURE = path.join(REPO_ROOT, "tests/ut/data/e2e/claude-sample.jsonl");

interface Plan {
  name: string;
  originals: number;
  dbs: number;
  fileCount: number;
  bytes: number;
  members: Array<{ taskId: string; kind: string; absentReason: string | null }>;
}

interface Manifest {
  format: string;
  run: { id: string; kind: string; name: string };
  sessions: Array<{ taskId: string; kind: string; dir: string; files: Array<{ path: string; role: string }> }>;
}

const fetchPlan = async (runId: string): Promise<Plan> => {
  const res = await fetch(`${BASE_URL}/api/observe/run/${encodeURIComponent(runId)}/export-archive/plan`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Plan>;
};

/** 菜单打开后点「原始文件」条目并捕获下载（菜单已开，不再点触发钮） */
async function downloadArchive(page: Page, run: RunWorkbenchPO): Promise<{ file: string; suggested: string }> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    run.exportMenuItem("archive").click(),
  ]);
  const suggested = download.suggestedFilename();
  const file = path.join(test.info().outputDir, suggested);
  await download.saveAs(file);
  return { file, suggested };
}

/** 7za 独立解包（不信任写入器自己的任何读回逻辑），返回包内文件相对路径（排序） */
function extract(file: string): { dir: string; entries: string[] } {
  const dir = path.join(test.info().outputDir, `unzipped-${Math.random().toString(36).slice(2, 8)}`);
  const r = spawnSync(sevenzipBin.path7za, ["x", "-y", `-o${dir}`, file], { stdio: ["ignore", "pipe", "pipe"] });
  expect(r.status, `7za extract failed: ${r.stderr?.toString()}`).toBe(0);
  const entries: string[] = [];
  const walk = (at: string, rel: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(path.join(at, entry.name), child);
      else entries.push(child);
    }
  };
  walk(dir, "");
  return { dir, entries: entries.sort() };
}

test.describe("工作台导出原始文件 (zip)", () => {
  test("solo：条目写明「1 个会话的原文件」→ 下载 zip → 原文件逐字节一致 + 根级清单", async ({ page }) => {
    const plan = await fetchPlan(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);
    expect(plan).toEqual(expect.objectContaining({ originals: 1, dbs: 0 }));

    await stripFilePicker(page);
    const run = new RunWorkbenchPO(page);
    await run.goto(`solo:${CLAUDE_SAMPLE_SESSION_ID}`);
    await run.openExportMenu();
    await expect(run.exportMenuItem("archive")).toContainText("原始文件 (zip)");
    // 副标题 = 计划端点的口径：几个会话的原文件、几个文件
    await expect(run.exportMenuItem("archive")).toContainText("1 个会话的原文件");
    await expect(run.exportMenuItem("archive")).toContainText(`${plan.fileCount} 个文件`);

    const { file, suggested } = await downloadArchive(page, run);
    expect(suggested).toBe(`context_session_${CLAUDE_SAMPLE_SESSION_ID}.zip`);
    const { dir, entries } = extract(file);
    expect(entries[0]).toBe("export-manifest.json");
    expect(entries).toContain(SOLO_MAIN);
    expect(fs.readFileSync(path.join(dir, ...SOLO_MAIN.split("/"))).equals(fs.readFileSync(SOLO_FIXTURE))).toBe(true);
    expect(entries.filter(e => e.startsWith(`sessions/${CLAUDE_SAMPLE_SESSION_ID}/`))).toHaveLength(plan.fileCount);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "export-manifest.json"), "utf-8")) as Manifest;
    expect(manifest.format).toBe("session-archive");
    expect(manifest.run).toEqual({ id: `solo:${CLAUDE_SAMPLE_SESSION_ID}`, kind: "solo", name: CLAUDE_SAMPLE_SESSION_ID });
    expect(manifest.sessions).toHaveLength(1);
    expect(manifest.sessions[0]).toEqual(expect.objectContaining({
      taskId: CLAUDE_SAMPLE_SESSION_ID, kind: "originals", dir: `sessions/${CLAUDE_SAMPLE_SESSION_ID}`,
    }));
    expect(manifest.sessions[0].files.find(f => f.role === "main")?.path).toBe(SOLO_MAIN);
  });

  test("bundle：条目文案与计划端点逐字一致（所见即所得），全员成员都进清单", async ({ page }) => {
    const plan = await fetchPlan(E2E_RUN_ID);
    expect(plan.members).toHaveLength(3);
    // 界面副标题的文案规则（describeSessionArchive 单一源）
    const expected = plan.dbs === 0
      ? `${plan.originals} 个会话的原文件`
      : plan.originals === 0
        ? "本机已无原文件"
        : `${plan.originals} 个会话按原文件，${plan.dbs} 个以导出 db（7z）代替`;

    await stripFilePicker(page);
    const run = new RunWorkbenchPO(page);
    await run.goto(E2E_RUN_ID);
    await run.openExportMenu();
    await expect(run.exportMenuItem("archive")).toContainText(expected);

    const { file } = await downloadArchive(page, run);
    const { dir, entries } = extract(file);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "export-manifest.json"), "utf-8")) as Manifest;
    // run 身份与计划端点同源（solo 取成员 taskId、bundle 取 run 名）
    expect(manifest.run).toEqual({ id: E2E_RUN_ID, kind: "bundle", name: plan.name });
    // 清单里的会话 = 计划里的全员成员，载荷种类逐个对得上
    expect(manifest.sessions.map(s => [s.taskId, s.kind])).toEqual(plan.members.map(m => [m.taskId, m.kind]));
    for (const session of manifest.sessions) {
      for (const f of session.files) expect(entries).toContain(f.path);
    }
  });
});
