// 数据目录解析（移植新增的最小模块）。
//
// 原实现把临时图写 `os.tmpdir()/qq-agent-smart-image`、去重历史也写在那里。
// 心语契约要求扩展只写 `DATA_DIR`（= <心语数据目录>/extensions），且**不要把状态
// 写回扩展包目录**。所以统一收到这里：
//
//   <DATA_DIR>/smart-image/history.json   去重记忆（与原实现同一个文件格式）
//   <DATA_DIR>/smart-image/tmp/*.png      下载校验后的临时图（发完不删，靠 sweepTemp 清）
//
// `api.dataDir` 是宿主/测试 harness 的注入口：setup(api) 里如果拿到就覆盖 DATA_DIR，
// 测试因此可以把数据写到临时目录，不会碰真实用户数据。
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

/** 覆盖根目录（宿主注入的 api.dataDir）；空 = 用兼容层的 DATA_DIR。 */
let override = '';

export function setDataRoot(dir) {
  override = String(dir ?? '').trim();
}

export function dataRoot() {
  return override || DATA_DIR;
}

/** 本技能自己的数据目录：<DATA_DIR>/smart-image。 */
export function smartImageDir() {
  return path.join(dataRoot(), 'smart-image');
}

/** 临时图目录：<DATA_DIR>/smart-image/tmp。 */
export function tempDir() {
  return path.join(smartImageDir(), 'tmp');
}
