package com.datayao.receiver;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import androidx.annotation.Nullable;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends BridgeActivity {
    private static final int SAVE_DOCUMENT_REQUEST = 9001;
    private final Object saveLock = new Object();
    private File pendingFile;
    private FileOutputStream pendingOutput;
    private String pendingName = "datayao-file.bin";
    private String pendingMimeType = "application/octet-stream";
    private long pendingExpectedSize = -1;
    private long pendingWrittenSize = 0;
    private boolean pendingFailed = false;

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new DataYaoAndroidBridge(), "DataYaoAndroid");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != SAVE_DOCUMENT_REQUEST) return;
        Uri destination = resultCode == RESULT_OK && data != null ? data.getData() : null;
        if (destination == null) {
            cleanupPendingFile();
            emitSaveResult(false, "已取消保存");
            return;
        }
        File source;
        String fileName;
        synchronized (saveLock) {
            source = pendingFile;
            fileName = pendingName;
        }
        if (source == null || !source.isFile()) {
            cleanupPendingFile();
            emitSaveResult(false, "临时文件不存在，请重新接收");
            return;
        }
        try (InputStream input = new FileInputStream(source);
             OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
            if (output == null) throw new IllegalStateException("无法打开目标文件");
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            output.flush();
            cleanupPendingFile();
            emitSaveResult(true, "已保存：" + fileName);
        } catch (Exception error) {
            cleanupPendingFile();
            emitSaveResult(false, "保存失败：" + errorMessage(error));
        }
    }

    private final class DataYaoAndroidBridge {
        @JavascriptInterface
        public void saveFileStart(String message) {
            synchronized (saveLock) {
                cleanupPendingFileLocked();
                try {
                    JSONObject payload = new JSONObject(message);
                    pendingName = safeFileName(payload.optString("name", "datayao-file.bin"));
                    pendingMimeType = payload.optString("mimeType", "application/octet-stream");
                    pendingExpectedSize = payload.optLong("size", -1);
                    pendingWrittenSize = 0;
                    pendingFailed = false;
                    pendingFile = File.createTempFile("datayao-", ".tmp", getCacheDir());
                    pendingOutput = new FileOutputStream(pendingFile, false);
                    emitSaveResult(true, "正在准备保存");
                } catch (Exception error) {
                    cleanupPendingFileLocked();
                    emitSaveResult(false, "无法准备保存：" + errorMessage(error));
                }
            }
        }

        @JavascriptInterface
        public void saveFileChunk(String message) {
            synchronized (saveLock) {
                try {
                    if (pendingOutput == null || pendingFailed) throw new IllegalStateException("保存会话未开始");
                    JSONObject payload = new JSONObject(message);
                    byte[] bytes = Base64.decode(payload.optString("base64", ""), Base64.DEFAULT);
                    pendingOutput.write(bytes);
                    pendingWrittenSize += bytes.length;
                } catch (Exception error) {
                    pendingFailed = true;
                    emitSaveResult(false, "写入失败：" + errorMessage(error));
                }
            }
        }

        @JavascriptInterface
        public void saveFileFinish(String ignored) {
            synchronized (saveLock) {
                try {
                    if (pendingOutput == null) throw new IllegalStateException("保存会话未开始");
                    pendingOutput.flush();
                    pendingOutput.close();
                    pendingOutput = null;
                    if (pendingFailed || (pendingExpectedSize >= 0 && pendingExpectedSize != pendingWrittenSize)) {
                        throw new IllegalStateException("文件写入不完整：" + pendingWrittenSize + "/" + pendingExpectedSize + " 字节");
                    }
                } catch (Exception error) {
                    cleanupPendingFileLocked();
                    emitSaveResult(false, errorMessage(error));
                    return;
                }
            }
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(pendingMimeType.isEmpty() ? "application/octet-stream" : pendingMimeType);
                intent.putExtra(Intent.EXTRA_TITLE, pendingName);
                startActivityForResult(intent, SAVE_DOCUMENT_REQUEST);
            });
        }
    }

    private void cleanupPendingFile() {
        synchronized (saveLock) {
            cleanupPendingFileLocked();
        }
    }

    private void cleanupPendingFileLocked() {
        if (pendingOutput != null) {
            try { pendingOutput.close(); } catch (Exception ignored) {}
            pendingOutput = null;
        }
        if (pendingFile != null) {
            try { pendingFile.delete(); } catch (Exception ignored) {}
            pendingFile = null;
        }
        pendingExpectedSize = -1;
        pendingWrittenSize = 0;
        pendingFailed = false;
    }

    private void emitSaveResult(boolean ok, String message) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("ok", ok);
            detail.put("message", message);
            String script = "window.dispatchEvent(new CustomEvent('datayao-android-save-result',{detail:" + detail + "}));";
            getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(script, null));
        } catch (Exception ignored) {}
    }

    private static String safeFileName(String name) {
        String safe = name == null ? "" : name.trim().replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        if (safe.isEmpty()) return "datayao-file.bin";
        return safe.substring(0, Math.min(safe.length(), 180));
    }

    private static String errorMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }
}
