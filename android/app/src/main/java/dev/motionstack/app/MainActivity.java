package dev.motionstack.app;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Color;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.widget.Toast;
import java.io.OutputStream;

/** Embedded offline Canvas UI. Videos stay on the device. */
public class MainActivity extends Activity {
    private static final int PICK_VIDEO = 101;
    private static final int SAVE_PNG = 102;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingPng;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(17,21,28));
        getWindow().setNavigationBarColor(Color.rgb(17,21,28));
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("video/*");
                    startActivityForResult(Intent.createChooser(intent, "Выбери видео"), PICK_VIDEO);
                } catch (Exception e) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, e.getMessage(), Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
        webView.loadUrl("file:///android_asset/index.html");
    }

    public class NativeBridge {
        @JavascriptInterface public void savePng(String imageDataUrl) {
            if (imageDataUrl == null || !imageDataUrl.startsWith("data:image/png;base64,")) return;
            if (imageDataUrl.length() > 90_000_000) return;
            runOnUiThread(() -> {
                pendingPng = imageDataUrl.substring("data:image/png;base64,".length());
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/png");
                intent.putExtra(Intent.EXTRA_TITLE, "motionstack_" + System.currentTimeMillis() + ".png");
                try { startActivityForResult(intent, SAVE_PNG); }
                catch(Exception e) {
                    pendingPng = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть сохранение", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_VIDEO) {
            if (fileCallback != null) {
                Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
                fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
                fileCallback = null;
            }
        } else if (requestCode == SAVE_PNG) {
            String image = pendingPng;
            pendingPng = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && image != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData())) {
                    if (os == null) throw new Exception("Cannot open destination");
                    os.write(Base64.decode(image, Base64.DEFAULT));
                    Toast.makeText(this, "PNG сохранён", Toast.LENGTH_LONG).show();
                } catch(Exception e) {
                    Toast.makeText(this, "Ошибка сохранения: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        }
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        webView.destroy();
        super.onDestroy();
    }
}
