import * as path from "path";

export const STUDY_REVIEW_MODEL = "Luna Max";
export const BRIDGE_VERSION = 1;
export const TASK_ID_PATTERN = /^[a-f0-9]{24}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

export interface StudyReviewRequest {
  version: number;
  request_id: string;
  kind: "study_review";
  model: "Luna Max";
  course_id: string;
  lesson_id: string;
  task_file: string;
  review_output: string;
}

export interface CodexModelRecord {
  id: string;
  model: string;
  displayName: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
}

export function selectLunaMax(models: CodexModelRecord[]): CodexModelRecord {
  const exact = models.filter((m) =>
    [m.displayName, m.model, m.id].some(
      (v) => typeof v === "string" && v.trim().toLowerCase() === STUDY_REVIEW_MODEL.toLowerCase(),
    ),
  );
  if (exact.length !== 1) {
    throw new Error(
      exact.length === 0
        ? "Luna Max not found in Codex model/list; refusing any model fallback"
        : "Luna Max model selection is ambiguous; refusing to dispatch",
    );
  }
  return exact[0];
}

export function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".."
    && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

export function parseStudyReviewRequest(
  raw: unknown, workspaceRoot: string,
): StudyReviewRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid study-review task envelope");
  }
  const v = raw as Record<string, unknown>;
  if (v.version !== BRIDGE_VERSION || v.kind !== "study_review"
      || v.model !== STUDY_REVIEW_MODEL
      || typeof v.request_id !== "string" || !TASK_ID_PATTERN.test(v.request_id)
      || typeof v.course_id !== "string" || !IDENTIFIER_PATTERN.test(v.course_id)
      || typeof v.lesson_id !== "string" || !IDENTIFIER_PATTERN.test(v.lesson_id)
      || typeof v.task_file !== "string" || typeof v.review_output !== "string") {
    throw new Error("Invalid study-review task fields");
  }
  const tasksRoot = path.join(workspaceRoot, ".tmp", "p5", "quiz-tasks");
  const reviewsRoot = path.join(workspaceRoot, ".tmp", "p5", "quiz-reviews");
  if (!isInside(v.task_file, tasksRoot) || !isInside(v.review_output, reviewsRoot)
      || path.extname(v.task_file) !== ".json" || path.extname(v.review_output) !== ".md") {
    throw new Error("Task path must remain within workspace .tmp/p5");
  }
  return v as unknown as StudyReviewRequest;
}

export function buildStudyReviewPrompt(task: StudyReviewRequest): string {
  return [
    "这是职业继续教育测验的只读学习辅助任务。请在当前工作区读取以下本地任务元数据：",
    task.task_file,
    "使用 agent-browser 只读检查与任务对应的课程页面，仅整理考点和可核实的判断依据。",
    "输出必须严格为 Markdown 表格，表头：| 题号 | 答案 | 简短解析 |",
    "下一行为：| --- | --- | --- |；每题一行，保留原题号。",
    "没有本人明确作答的题目，答案一律填写「待本人作答」；不得推断正式考核的选项。",
    "简短解析每条不超过80个汉字，证据不足则写「需核实」，不得编造。",
    "请将同一表格保存到：" + task.review_output,
    "不得点击答题选项、提交考核、修改学习进度、绕过网页权限或身份检查。",
    "答题及正式提交由本人完成；其他程序只在网站真实显示测验完成后继续视频。",
  ].join("\n");
}
