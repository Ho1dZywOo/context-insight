// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// You may refer to the License for details on what you can and cannot do with this software.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See the License for the specific language governing permissions and limitations under the License.

// 摄取突变 → 观测缓存失效（单点）。
//
// 契约：任何改写会话行的摄取路径（导入 / 删除 / 重导 / 增量刷新 / 回收站恢复
// / lake 导入）完成后必须调用本函数。观测侧一切「键含成员行 id 或会话清单」
// 的缓存在此一次失效：
// - run 观测作用域（scope 缓存持有成员行 id；重导即换行，死行 id 会令
//   turns/executions/skills 等 12+ 个 run 端点按 IN(死行) 静默查空——
//   200 + 空列表、零报错，Overview 指标归零的直接根因）
// - lake 视图五缓存（run 列表 / insight 清单 / 评分卡 / 笔记分 / 活跃时长）
//
// 此前各突变点各自记忆要失效哪些缓存：delete 记了 lake、import 谁都没记、
// scope 缓存无人知晓——按「解释权单点」原则收口于此，新增缓存或新增突变点
// 都只改这一处。
import { invalidateCaches } from '@/lib/collection/lake-view/runs';
import { invalidateRunScopeCache } from '@/lib/run/observe/scope';

export function invalidateObservationCaches(): void {
  invalidateRunScopeCache();
  invalidateCaches();
}
