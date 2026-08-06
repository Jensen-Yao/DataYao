import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';

const LOG_DOMAIN = 0x0000;
const LOG_TAG = 'DataYao';

interface CameraPermissionPayload {
  granted: boolean;
  message: string;
}

interface TextPayload {
  text?: string;
}

interface SaveStartPayload {
  name?: string;
  size?: number;
}

interface SaveChunkPayload {
  base64?: string;
}

interface SaveResultPayload {
  ok: boolean;
  message: string;
}

function errorMessage(error: Object): string {
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Unknown HarmonyOS error';
  }
}

function safeFileName(name: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 180) : 'datayao-file.bin';
}

function cameraPermissionDetail(granted: boolean, message: string): string {
  const detail: CameraPermissionPayload = { granted, message };
  return JSON.stringify(detail);
}

function resultDetail(ok: boolean, message: string): string {
  const detail: SaveResultPayload = { ok, message };
  return JSON.stringify(detail);
}

class DataYaoBridge {
  private context?: common.UIAbilityContext;
  private controller?: webview.WebviewController;
  private pendingFile?: fileIo.File;
  private pendingPath: string = '';
  private pendingName: string = 'datayao-file.bin';
  private pendingExpectedSize: number = -1;
  private pendingWrittenSize: number = 0;
  private pendingFailed: boolean = false;

  setContext(context: common.UIAbilityContext): void {
    this.context = context;
  }

  setController(controller: webview.WebviewController): void {
    this.controller = controller;
  }

  requestCameraPermission(): void {
    void this.requestCameraPermissionAsync();
  }

  private async requestCameraPermissionAsync(): Promise<void> {
    if (!this.context) {
      this.emit('datayao-harmony-camera-permission', cameraPermissionDetail(false, '鸿蒙运行环境未就绪'));
      return;
    }
    try {
      const permissions: Permissions[] = ['ohos.permission.CAMERA'];
      const manager = abilityAccessCtrl.createAtManager();
      const result = await manager.requestPermissionsFromUser(this.context, permissions);
      const granted = result.authResults.length > 0 && result.authResults[0] === 0;
      this.emit(
        'datayao-harmony-camera-permission',
        cameraPermissionDetail(granted, granted ? '' : '摄像头权限未授予')
      );
    } catch (error) {
      hilog.error(LOG_DOMAIN, LOG_TAG, 'Camera permission request failed: %{public}s', errorMessage(error as Object));
      this.emit('datayao-harmony-camera-permission', cameraPermissionDetail(false, '摄像头权限请求失败'));
    }
  }

  copyText(message: string): void {
    try {
      const payload = JSON.parse(message) as TextPayload;
      const text = payload.text || '';
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      void pasteboard.getSystemPasteboard().setData(data).then(() => {
        this.emit('datayao-harmony-copy-result', resultDetail(true, '已复制到剪贴板'));
      }).catch((error: Object) => {
        this.emit('datayao-harmony-copy-result', resultDetail(false, errorMessage(error)));
      });
    } catch (error) {
      this.emit('datayao-harmony-copy-result', resultDetail(false, errorMessage(error as Object)));
    }
  }

  saveFileStart(message: string): void {
    try {
      this.resetPendingFile(true);
      const payload = JSON.parse(message) as SaveStartPayload;
      if (!this.context) throw new Error('鸿蒙运行环境未就绪');
      this.pendingName = safeFileName(payload.name || 'datayao-file.bin');
      this.pendingExpectedSize = payload.size === undefined ? -1 : payload.size;
      this.pendingWrittenSize = 0;
      this.pendingFailed = false;
      this.pendingPath = `${this.context.cacheDir}/datayao-${Date.now()}.tmp`;
      this.pendingFile = fileIo.openSync(
        this.pendingPath,
        fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      );
      this.emit('datayao-harmony-save-result', resultDetail(true, '正在准备保存'));
    } catch (error) {
      this.resetPendingFile(true);
      this.emit('datayao-harmony-save-result', resultDetail(false, `无法准备保存：${errorMessage(error as Object)}`));
    }
  }

  saveFileChunk(message: string): void {
    try {
      if (!this.pendingFile) throw new Error('保存会话未开始');
      const payload = JSON.parse(message) as SaveChunkPayload;
      const bytes = new util.Base64Helper().decodeSync(payload.base64 || '');
      const written = fileIo.writeSync(this.pendingFile.fd, bytes.buffer as ArrayBuffer);
      this.pendingWrittenSize += written;
      if (written !== bytes.byteLength) {
        this.pendingFailed = true;
        throw new Error(`只写入了 ${written}/${bytes.byteLength} 字节`);
      }
    } catch (error) {
      this.pendingFailed = true;
      this.emit('datayao-harmony-save-result', resultDetail(false, `写入失败：${errorMessage(error as Object)}`));
    }
  }

  saveFileFinish(_message: string): void {
    const path = this.pendingPath;
    const name = this.pendingName;
    const invalid = this.pendingFailed ||
      (this.pendingExpectedSize >= 0 && this.pendingExpectedSize !== this.pendingWrittenSize);
    const expectedSize = this.pendingExpectedSize;
    const writtenSize = this.pendingWrittenSize;
    if (invalid) {
      this.resetPendingFile(true);
      this.emit(
        'datayao-harmony-save-result',
        resultDetail(false, `文件写入不完整：${writtenSize}/${expectedSize} 字节`)
      );
      return;
    }
    this.resetPendingFile(false);
    if (!path) {
      this.emit('datayao-harmony-save-result', resultDetail(false, '保存会话未开始'));
      return;
    }
    void this.savePendingFile(path, name);
  }

  private async savePendingFile(path: string, name: string): Promise<void> {
    try {
      if (!this.context) throw new Error('鸿蒙运行环境未就绪');
      const documentPicker = new picker.DocumentViewPicker(this.context);
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [name];
      const uris = await documentPicker.save(options);
      if (!uris || uris.length === 0 || !uris[0]) throw new Error('用户取消了保存');
      const destination = fileIo.openSync(
        uris[0],
        fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      );
      try {
        fileIo.copyFileSync(path, destination.fd);
      } finally {
        fileIo.closeSync(destination);
      }
      fileIo.unlinkSync(path);
      this.emit('datayao-harmony-save-result', resultDetail(true, `已保存：${name}`));
    } catch (error) {
      try {
        fileIo.unlinkSync(path);
      } catch (_) {
      }
      this.emit('datayao-harmony-save-result', resultDetail(false, `保存失败：${errorMessage(error as Object)}`));
    }
  }

  private resetPendingFile(removeTemp: boolean): void {
    if (this.pendingFile) {
      try {
        fileIo.closeSync(this.pendingFile);
      } catch (_) {
      }
      this.pendingFile = undefined;
    }
    if (removeTemp && this.pendingPath) {
      try {
        fileIo.unlinkSync(this.pendingPath);
      } catch (_) {
      }
    }
    this.pendingPath = '';
    this.pendingExpectedSize = -1;
    this.pendingWrittenSize = 0;
    this.pendingFailed = false;
  }

  private emit(eventName: string, detailJson: string): void {
    if (!this.controller) return;
    const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, { detail: ${detailJson} }));`;
    void this.controller.runJavaScript(script).catch(() => undefined);
  }
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController('DataYaoWeb');
  private bridge: DataYaoBridge = new DataYaoBridge();
  @State private loaded: boolean = false;

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.bridge.setContext(context);
    this.bridge.setController(this.controller);
    try {
      webview.WebviewController.initializeWebEngine();
    } catch (error) {
      hilog.error(LOG_DOMAIN, LOG_TAG, 'ArkWeb initialization failed: %{public}s', errorMessage(error as Object));
    }
  }

  build() {
    Stack() {
      Web({
        src: $rawfile('datayao/index.html'),
        controller: this.controller
      })
        .javaScriptAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .domStorageAccess(true)
        .onPermissionRequest((event) => {
          const resources = event.request.getAccessibleResource();
          if (resources.indexOf('TYPE_VIDEO_CAPTURE') >= 0) {
            event.request.grant(['TYPE_VIDEO_CAPTURE']);
          } else {
            event.request.deny();
          }
        })
        .onPageEnd(() => {
          this.loaded = true;
        })
        .onErrorReceive((event) => {
          hilog.error(LOG_DOMAIN, LOG_TAG, 'ArkWeb resource error: %{public}s', event.error.getErrorInfo());
        })
        .javaScriptProxy({
          object: this.bridge,
          name: 'DataYaoHarmony',
          methodList: ['requestCameraPermission', 'copyText', 'saveFileStart', 'saveFileChunk', 'saveFileFinish'],
          controller: this.controller
        })
        .width('100%')
        .height('100%')

      if (!this.loaded) {
        Column({ space: 8 }) {
          Text('DataYao')
            .fontSize(22)
            .fontWeight(FontWeight.Medium)
            .fontColor('#ffffff')
          Text('正在加载接收端')
            .fontSize(14)
            .fontColor('#b8c4d4')
        }
        .padding(24)
        .borderRadius(16)
        .backgroundColor('#17212c')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0b1118')
  }
}
