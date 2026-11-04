/*
  Warnings:

  - You are about to alter the column `cacheCreationInputTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `cacheReadInputTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `inputTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `latencyMs` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `maxSingleCallTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `outputTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `reasoningTokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `tokens` on the `Execution` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `subagentLatencyMs` on the `InteractionBridge` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `subagentTokens` on the `InteractionBridge` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalCacheReadTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalCacheWriteTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalInputTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalLatencyMs` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalOutputTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalReasoningTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `totalTokens` on the `Session` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "agentName" TEXT,
    "agentSessionId" TEXT,
    "isSubagent" BOOLEAN NOT NULL DEFAULT false,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "parentExecutionId" TEXT,
    "rootExecutionId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "tokens" BIGINT NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "reasoningTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadInputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheCreationInputTokens" BIGINT NOT NULL DEFAULT 0,
    "maxSingleCallTokens" BIGINT NOT NULL DEFAULT 0,
    "cost" REAL NOT NULL DEFAULT 0,
    "latencyMs" BIGINT NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallErrorCount" INTEGER NOT NULL DEFAULT 0,
    "llmCallCount" INTEGER NOT NULL DEFAULT 0,
    "skillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "skillInvokeCount" INTEGER NOT NULL DEFAULT 0,
    "finalResult" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Execution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Execution" ("agentName", "agentSessionId", "cacheCreationInputTokens", "cacheReadInputTokens", "cost", "createdAt", "depth", "finalResult", "id", "inputTokens", "isSubagent", "latencyMs", "llmCallCount", "maxSingleCallTokens", "model", "outputTokens", "parentExecutionId", "reasoningTokens", "rootExecutionId", "sessionId", "skillInvokeCount", "skillLoadCount", "subagentName", "subagentType", "tokens", "toolCallCount", "toolCallErrorCount") SELECT "agentName", "agentSessionId", "cacheCreationInputTokens", "cacheReadInputTokens", "cost", "createdAt", "depth", "finalResult", "id", "inputTokens", "isSubagent", "latencyMs", "llmCallCount", "maxSingleCallTokens", "model", "outputTokens", "parentExecutionId", "reasoningTokens", "rootExecutionId", "sessionId", "skillInvokeCount", "skillLoadCount", "subagentName", "subagentType", "tokens", "toolCallCount", "toolCallErrorCount" FROM "Execution";
DROP TABLE "Execution";
ALTER TABLE "new_Execution" RENAME TO "Execution";
CREATE INDEX "Execution_sessionId_idx" ON "Execution"("sessionId");
CREATE INDEX "Execution_parentExecutionId_idx" ON "Execution"("parentExecutionId");
CREATE INDEX "Execution_rootExecutionId_idx" ON "Execution"("rootExecutionId");
CREATE INDEX "Execution_isSubagent_idx" ON "Execution"("isSubagent");
CREATE INDEX "Execution_agentSessionId_idx" ON "Execution"("agentSessionId");
CREATE TABLE "new_InteractionBridge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "dispatchExecutionId" TEXT NOT NULL,
    "dispatchTurnId" TEXT,
    "dispatchToolCallId" TEXT,
    "dispatchContent" TEXT,
    "dispatchTimestamp" DATETIME,
    "responseExecutionId" TEXT,
    "responseTurnId" TEXT,
    "responseContent" TEXT,
    "responseTimestamp" DATETIME,
    "subagentSessionId" TEXT,
    "subagentType" TEXT,
    "subagentName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "subagentTokens" BIGINT NOT NULL DEFAULT 0,
    "subagentLatencyMs" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InteractionBridge_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_InteractionBridge" ("createdAt", "dispatchContent", "dispatchExecutionId", "dispatchTimestamp", "dispatchToolCallId", "dispatchTurnId", "id", "responseContent", "responseExecutionId", "responseTimestamp", "responseTurnId", "sessionId", "status", "subagentLatencyMs", "subagentName", "subagentSessionId", "subagentTokens", "subagentType", "updatedAt") SELECT "createdAt", "dispatchContent", "dispatchExecutionId", "dispatchTimestamp", "dispatchToolCallId", "dispatchTurnId", "id", "responseContent", "responseExecutionId", "responseTimestamp", "responseTurnId", "sessionId", "status", "subagentLatencyMs", "subagentName", "subagentSessionId", "subagentTokens", "subagentType", "updatedAt" FROM "InteractionBridge";
DROP TABLE "InteractionBridge";
ALTER TABLE "new_InteractionBridge" RENAME TO "InteractionBridge";
CREATE INDEX "InteractionBridge_sessionId_idx" ON "InteractionBridge"("sessionId");
CREATE INDEX "InteractionBridge_dispatchExecutionId_idx" ON "InteractionBridge"("dispatchExecutionId");
CREATE INDEX "InteractionBridge_responseExecutionId_idx" ON "InteractionBridge"("responseExecutionId");
CREATE INDEX "InteractionBridge_subagentSessionId_idx" ON "InteractionBridge"("subagentSessionId");
CREATE INDEX "InteractionBridge_status_idx" ON "InteractionBridge"("status");
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "label" TEXT,
    "query" TEXT,
    "framework" TEXT NOT NULL DEFAULT 'unknown',
    "model" TEXT,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "totalTokens" BIGINT NOT NULL DEFAULT 0,
    "totalInputTokens" BIGINT NOT NULL DEFAULT 0,
    "totalOutputTokens" BIGINT NOT NULL DEFAULT 0,
    "totalReasoningTokens" BIGINT NOT NULL DEFAULT 0,
    "totalCacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "totalCacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "totalLatencyMs" BIGINT NOT NULL DEFAULT 0,
    "totalToolCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalLlmCallCount" INTEGER NOT NULL DEFAULT 0,
    "totalSkillLoadCount" INTEGER NOT NULL DEFAULT 0,
    "totalSubagentCount" INTEGER NOT NULL DEFAULT 0,
    "rootExecutionId" TEXT,
    "sourcePath" TEXT,
    "parentId" TEXT,
    "version" TEXT,
    "directory" TEXT,
    "summaryAdditions" INTEGER NOT NULL DEFAULT 0,
    "summaryDeletions" INTEGER NOT NULL DEFAULT 0,
    "summaryFiles" INTEGER NOT NULL DEFAULT 0,
    "user" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Session" ("createdAt", "directory", "endTime", "framework", "id", "label", "model", "parentId", "query", "rootExecutionId", "sourcePath", "startTime", "summaryAdditions", "summaryDeletions", "summaryFiles", "taskId", "totalCacheReadTokens", "totalCacheWriteTokens", "totalCost", "totalInputTokens", "totalLatencyMs", "totalLlmCallCount", "totalOutputTokens", "totalReasoningTokens", "totalSkillLoadCount", "totalSubagentCount", "totalTokens", "totalToolCallCount", "updatedAt", "user", "version") SELECT "createdAt", "directory", "endTime", "framework", "id", "label", "model", "parentId", "query", "rootExecutionId", "sourcePath", "startTime", "summaryAdditions", "summaryDeletions", "summaryFiles", "taskId", "totalCacheReadTokens", "totalCacheWriteTokens", "totalCost", "totalInputTokens", "totalLatencyMs", "totalLlmCallCount", "totalOutputTokens", "totalReasoningTokens", "totalSkillLoadCount", "totalSubagentCount", "totalTokens", "totalToolCallCount", "updatedAt", "user", "version" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE UNIQUE INDEX "Session_taskId_framework_key" ON "Session"("taskId", "framework");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
