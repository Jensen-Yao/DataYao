import { createRequire } from 'module';
import { resolve } from 'path';

const hvigorEntry = process.argv[1] ? resolve(process.argv[1]) : __filename;
const hvigorRequire = createRequire(hvigorEntry);
const { appTasks } = hvigorRequire('@ohos/hvigor-ohos-plugin');

export default {
  system: appTasks,
  plugins: []
};
