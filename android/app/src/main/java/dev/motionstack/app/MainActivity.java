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
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.ByteBufferExtractor;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.components.containers.NormalizedKeypoint;
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenter;
import com.google.mediapipe.tasks.vision.interactivesegmenter.InteractiveSegmenterOptions;
import com.google.mediapipe.tasks.vision.interactivesegmenter.Stroke;
import org.json.JSONObject;
import java.util.Arrays;
import java.nio.FloatBuffer;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;


/** Embedded offline Canvas UI. Videos stay on the device. */
public class MainActivity extends Activity {
    private static final int PICK_VIDEO = 101;
    private static final int SAVE_PNG = 102;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingPng;
    private final ExecutorService aiExecutor = Executors.newSingleThreadExecutor();
    private InteractiveSegmenter segmenter;

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

    private void sendSegmentation(int id, String mask, String error) {
        runOnUiThread(() -> {
            if (webView==null) return;
            String js="window.motionStackReceive("+id+","+
                (mask==null?"null":JSONObject.quote(mask))+","+
                (error==null?"null":JSONObject.quote(error))+");";
            webView.evaluateJavascript(js,null);
        });
    }
    public class NativeBridge {
        /**
         * JSON callback: window.motionStackReceive(id, maskPngDataURL, error).
         * The frame comes from an offline canvas, so no video ever leaves the device.
         */
        @JavascriptInterface public void segmentFrame(int requestId, String dataUrl, double x, double y) {
            if (dataUrl == null || !dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length()>9000000) {
                sendSegmentation(requestId, null, "Слишком большой или неподдерживаемый кадр"); return;
            }
            final double nx = Math.max(0.001, Math.min(.999, x));
            final double ny = Math.max(0.001, Math.min(.999, y));
            aiExecutor.submit(() -> {
                try {
                    if (segmenter == null) {
                        BaseOptions base = BaseOptions.builder()
                            .setModelAssetPath("interactive_segmentation.task").build();
                        InteractiveSegmenterOptions options = InteractiveSegmenterOptions.builder()
                            .setBaseOptions(base).build();
                        segmenter = InteractiveSegmenter.createFromOptions(MainActivity.this, options);
                    }
                    byte[] input = Base64.decode(dataUrl.substring("data:image/jpeg;base64,".length()), Base64.DEFAULT);
                    Bitmap original = BitmapFactory.decodeByteArray(input, 0, input.length);
                    if (original == null) throw new IllegalArgumentException("Невозможно прочитать кадр");
                    MPImage image = new BitmapImageBuilder(original).build();
                    segmenter.setImage(image);
                    Stroke stroke = Stroke.builder()
                        .setBrushMode(Stroke.BrushMode.POSITIVE)
                        .setPoints(Arrays.asList(NormalizedKeypoint.create((float)nx, (float)ny)))
                        .setCompleted(true).build();
                    MPImage mpMask = segmenter.segment(Arrays.asList(stroke));
                    FloatBuffer scores = ByteBufferExtractor.extract(mpMask).asFloatBuffer();
                    scores.rewind();
                    int width=mpMask.getWidth(),height=mpMask.getHeight();
                    if(width<=0 || height<=0 || (long)width*height>3500000)
                        throw new IllegalStateException("Некорректный размер AI-маски");
                    int[] pixels = new int[width*height];
                    for(int i=0;i<pixels.length;i++){
                        // A soft confidence ramp instead of a harsh polygon/rectangular crop.
                        float confidence = scores.get();
                        float alpha = Math.max(0f,Math.min(1f,(confidence-.30f)/.45f));
                        pixels[i]=Color.argb(Math.round(alpha*255),255,255,255);
                    }
                    Bitmap mask = Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
                    mask.setPixels(pixels,0,width,0,0,width,height);
                    ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                    if(!mask.compress(Bitmap.CompressFormat.PNG,100,bytes))
                        throw new IllegalStateException("Не удалось создать PNG-маску");
                    String output="data:image/png;base64,"+Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP);
                    sendSegmentation(requestId,output,null);
                    mask.recycle();mpMask.close();image.close();original.recycle();
                } catch (Exception e) {
                    android.util.Log.e("MotionStack", "Interactive segmentation error", e);
                    sendSegmentation(requestId, null, e.getMessage()==null ? e.getClass().getSimpleName() : e.getMessage());
                }
            });
        }

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
        aiExecutor.shutdownNow(); if (segmenter!=null) segmenter.close(); webView.destroy();
        super.onDestroy();
    }
}
