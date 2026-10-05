package com.huah.musicfree.hy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 播放通知服务：把正在播放的歌挂到系统下拉通知栏（MediaStyle 媒体卡片），
 * 同时用前台服务保活，避免应用切后台后 WebView 里的音频被系统回收。
 *
 * 音频本体在 WebView 的 HTMLAudioElement 里，这里不碰音频，只负责「状态展示」与
 * 「控制转发」：JS 侧经 MediaNotificationPlugin 推送歌曲元数据 / 播放状态，
 * 通知按钮与 MediaSession 回调（耳机线控、蓝牙）再经插件原路转发回 JS。
 */
public class MediaPlaybackService extends Service {

    private static final String CHANNEL_ID = "playback_now";
    /** 早期版本用过 IMPORTANCE_LOW 的「playback」频道（部分 ROM 会把它收进静默折叠区） */
    private static final String LEGACY_CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 0x4D46; // "MF"
    /** 封面解码后压到这个边长以内，通知栏够用，也不至于把 Bitmap 传崩 */
    private static final int MAX_ARTWORK_PX = 512;

    /** 通知按钮 / MediaSession 回调的动作名（与 JS 侧 mediaNotification.ts 约定一致） */
    public static final String ACTION_TOGGLE = "toggle";
    public static final String ACTION_PLAY = "play";
    public static final String ACTION_PAUSE = "pause";
    public static final String ACTION_PREVIOUS = "previous";
    public static final String ACTION_NEXT = "next";
    public static final String ACTION_SEEK = "seek";
    public static final String ACTION_CLOSE = "close";

    /** 播放控制动作回调（插件注册，转发给 WebView 里的 JS） */
    public interface ActionListener {
        void onAction(String action, double position);
    }

    private static volatile ActionListener actionListener;

    public static void setActionListener(ActionListener listener) {
        actionListener = listener;
    }

    // ---------- 播放状态快照（插件线程写、主线程读，字段访问都走 volatile） ----------
    private static volatile String sTitle = "";
    private static volatile String sArtist = "";
    private static volatile String sAlbum = "";
    private static volatile String sArtworkUrl = "";
    private static volatile long sDurationMs = 0;
    private static volatile boolean sPlaying = false;
    private static volatile long sPositionMs = 0;
    /** 上次上报进度时的时间戳，播放中用它外推出「现在的进度」 */
    private static volatile long sPositionWall = 0;
    private static volatile float sRate = 1f;

    private static MediaPlaybackService instance;

    private MediaSessionCompat session;
    private NotificationManager notifications;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final ExecutorService ARTWORK_EXECUTOR = Executors.newSingleThreadExecutor();
    private Bitmap artworkBitmap;
    /** 当前 bitmap 对应的封面地址，避免同一首歌重复解码 */
    private String artworkBitmapKey = null;
    private boolean foregroundStarted = false;
    /** 熄屏后 CPU 可能休眠、WiFi 会进省电模式，流式播放期间得按住这两把锁 */
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    /** 输出设备监听：拔耳机 / 断蓝牙时暂停，避免声音从外放突然炸出来 */
    private AudioManager audioManager;
    private AudioDeviceCallback audioDeviceCallback;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        notifications = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        ensureChannel();

        session = new MediaSessionCompat(this, "MusicFreePlayback");
        session.setActive(true);
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                dispatch(ACTION_PLAY);
            }

            @Override
            public void onPause() {
                dispatch(ACTION_PAUSE);
            }

            @Override
            public void onSkipToPrevious() {
                dispatch(ACTION_PREVIOUS);
            }

            @Override
            public void onSkipToNext() {
                dispatch(ACTION_NEXT);
            }

            @Override
            public void onSeekTo(long pos) {
                dispatch(ACTION_SEEK, pos / 1000.0);
            }

            @Override
            public void onStop() {
                dispatch(ACTION_CLOSE);
            }
        });

        registerHeadphoneGuard();
    }

    /** 拔出有线耳机 / 断开蓝牙耳机时暂停播放（WebView 的音频焦点不覆盖这个场景） */
    private void registerHeadphoneGuard() {
        try {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager == null) {
                return;
            }
            audioDeviceCallback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    if (removedDevices == null || !sPlaying) {
                        return;
                    }
                    for (AudioDeviceInfo device : removedDevices) {
                        if (device.isSink() && isHeadphoneType(device.getType())) {
                            dispatch(ACTION_PAUSE);
                            return;
                        }
                    }
                }
            };
            audioManager.registerAudioDeviceCallback(audioDeviceCallback, null);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static boolean isHeadphoneType(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return true;
            default:
                return false;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) {
            // 经 startForegroundService 起来：进入前台并挂通知
            enterForeground();
        } else if (ACTION_SEEK.equals(action)) {
            dispatch(ACTION_SEEK, intent.getDoubleExtra("position", 0d));
        } else {
            dispatch(action);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务划掉应用：WebView 已死，音频必停，通知留着只会误导
        shutdown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseKeepAlive();
        if (audioManager != null && audioDeviceCallback != null) {
            try {
                audioManager.unregisterAudioDeviceCallback(audioDeviceCallback);
            } catch (Exception ignored) {
            }
            audioDeviceCallback = null;
        }
        if (instance == this) {
            instance = null;
        }
        if (session != null) {
            try {
                session.release();
            } catch (Exception ignored) {
            }
            session = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- 供插件调用的静态入口（任意线程，内部统一切主线程） ----------

    static void updateMetadata(
        Context context,
        String title,
        String artist,
        String album,
        String artwork,
        double durationSec
    ) {
        sTitle = title == null ? "" : title;
        sArtist = artist == null ? "" : artist;
        sAlbum = album == null ? "" : album;
        sArtworkUrl = artwork == null ? "" : artwork;
        if (durationSec > 0) {
            sDurationMs = (long) (durationSec * 1000);
        }
        MediaPlaybackService service = instance;
        if (service != null) {
            service.main.post(service::refreshMetadata);
        }
    }

    static void updatePlayback(
        Context context,
        boolean playing,
        double positionSec,
        double rate,
        double durationSec
    ) {
        sPlaying = playing;
        sPositionMs = (long) (positionSec * 1000);
        sPositionWall = SystemClock.elapsedRealtime();
        if (rate > 0) {
            sRate = (float) rate;
        }
        if (durationSec > 0) {
            sDurationMs = (long) (durationSec * 1000);
        }
        MediaPlaybackService service = instance;
        if (service == null) {
            if (!playing) {
                // 还没开播过：暂停状态不挂通知
                return;
            }
            // 第一次开播：起前台服务（onStartCommand 里会 enterForeground）
            try {
                Intent intent = new Intent(context, MediaPlaybackService.class);
                ContextCompat.startForegroundService(context, intent);
            } catch (Exception e) {
                // 后台被限制起前台服务（应用在前台时正常不会走到）：退化为普通通知
                e.printStackTrace();
            }
            return;
        }
        service.main.post(service::applyPlaybackState);
    }

    static void stop(Context context) {
        MediaPlaybackService service = instance;
        if (service != null) {
            service.main.post(service::shutdown);
        }
    }

    // ---------- 主线程内部逻辑 ----------

    /** 应用最新播放状态：更新会话 + 按需挂/刷通知 */
    private void applyPlaybackState() {
        if (session == null) {
            return;
        }
        session.setPlaybackState(buildPlaybackState());
        // 播放与暂停都保持前台身份：暂停就退前台的话进程失去保护，
        // ROM 省电 / 内存回收下很快被杀，表现为「暂停一会儿就自己没了」。
        // 暂停态通知 setOngoing(false) 仍可划掉（deleteIntent → close 走彻底停止）。
        if (!foregroundStarted) {
            enterForeground();
        } else {
            postNotification();
        }
        // 音频本体在 WebView 里，熄屏后 WiFi 休眠 / CPU 深眠会直接掐断取流
        updateKeepAlive();
    }

    /** 播放中持有唤醒锁与 WiFi 锁，暂停/停止即释放 */
    private void updateKeepAlive() {
        if (sPlaying) {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    if (wakeLock == null) {
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MusicFreeHy:playback");
                        wakeLock.setReferenceCounted(false);
                    }
                    if (!wakeLock.isHeld()) {
                        wakeLock.acquire();
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            try {
                WifiManager wm =
                    (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    if (wifiLock == null) {
                        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                        wifiLock = wm.createWifiLock(mode, "MusicFreeHy:playback");
                        wifiLock.setReferenceCounted(false);
                    }
                    if (!wifiLock.isHeld()) {
                        wifiLock.acquire();
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        } else {
            releaseKeepAlive();
        }
    }

    private void releaseKeepAlive() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {
        }
    }

    private void enterForeground() {
        refreshMetadata();
        if (session != null) {
            session.setPlaybackState(buildPlaybackState());
        }
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            foregroundStarted = true;
        } catch (Exception e) {
            // 起前台被系统拒绝：尽量还是把通知挂出来
            e.printStackTrace();
            postNotification();
        }
    }

    private void postNotification() {
        if (notifications == null) {
            return;
        }
        try {
            notifications.notify(NOTIFICATION_ID, buildNotification());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void refreshMetadata() {
        if (session == null) {
            return;
        }
        MediaMetadataCompat.Builder builder = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, sTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, sArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, sAlbum)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, Math.max(sDurationMs, 0));
        if (artworkBitmap != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artworkBitmap);
        }
        session.setMetadata(builder.build());
        postNotification();
        loadArtworkIfNeeded();
    }

    /** 封面换了就异步解码，完成后重刷元数据与通知 */
    private void loadArtworkIfNeeded() {
        String url = sArtworkUrl;
        if (url.equals(artworkBitmapKey)) {
            return;
        }
        artworkBitmapKey = url;
        artworkBitmap = null;
        if (url.isEmpty()) {
            return;
        }
        ARTWORK_EXECUTOR.execute(() -> {
            Bitmap bitmap;
            try {
                bitmap = decodeArtwork(url);
            } catch (Exception e) {
                bitmap = null;
            }
            Bitmap decoded = bitmap;
            main.post(() -> {
                if (session == null || !url.equals(artworkBitmapKey)) {
                    return; // 已经换歌 / 服务已停
                }
                artworkBitmap = decoded;
                refreshMetadata();
            });
        });
    }

    private PlaybackStateCompat buildPlaybackState() {
        long position = sPlaying ? interpolatePositionMs() : sPositionMs;
        return new PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY
                    | PlaybackStateCompat.ACTION_PAUSE
                    | PlaybackStateCompat.ACTION_PLAY_PAUSE
                    | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                    | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackStateCompat.ACTION_SEEK_TO
                    | PlaybackStateCompat.ACTION_STOP
            )
            .setState(
                sPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                position,
                sPlaying ? Math.max(sRate, 0.01f) : 0f
            )
            .build();
    }

    /** 播放中按上次上报的位置 + 速率外推当前进度（系统进度条靠它走动） */
    private static long interpolatePositionMs() {
        long elapsed = SystemClock.elapsedRealtime() - sPositionWall;
        long projected = sPositionMs + (long) (elapsed * Math.max(sRate, 0f));
        if (sDurationMs > 0) {
            return Math.min(projected, sDurationMs);
        }
        return projected;
    }

    private Notification buildNotification() {
        String title = sTitle.isEmpty() ? getString(R.string.app_name) : sTitle;
        PendingIntent contentIntent = buildContentIntent();
        PendingIntent closeIntent = makeServiceIntent(ACTION_CLOSE);
        boolean playing = sPlaying;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(sArtist.isEmpty() ? sAlbum : sArtist)
            .setLargeIcon(artworkBitmap != null ? artworkBitmap : appIconBitmap())
            .setContentIntent(contentIntent)
            .setDeleteIntent(closeIntent)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(playing)
            .addAction(
                android.R.drawable.ic_media_previous,
                "上一首",
                makeServiceIntent(ACTION_PREVIOUS)
            )
            .addAction(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "暂停" : "播放",
                makeServiceIntent(ACTION_TOGGLE)
            )
            .addAction(
                android.R.drawable.ic_media_next,
                "下一首",
                makeServiceIntent(ACTION_NEXT)
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "关闭",
                closeIntent
            )
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session == null ? null : session.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );
        return builder.build();
    }

    private PendingIntent buildContentIntent() {
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (intent == null) {
            intent = new Intent(this, MainActivity.class);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private PendingIntent makeServiceIntent(String action) {
        Intent intent = new Intent(this, MediaPlaybackService.class);
        intent.setAction(action);
        if (ACTION_SEEK.equals(action)) {
            intent.putExtra("position", 0d);
        }
        return PendingIntent.getService(
            this,
            action.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void dispatch(String action) {
        dispatch(action, 0d);
    }

    private void dispatch(String action, double position) {
        ActionListener listener = actionListener;
        if (listener != null) {
            listener.onAction(action, position);
        }
    }

    private void shutdown() {
        releaseKeepAlive();
        if (notifications != null) {
            try {
                notifications.cancel(NOTIFICATION_ID);
            } catch (Exception ignored) {
            }
        }
        if (session != null) {
            try {
                session.setActive(false);
            } catch (Exception ignored) {
            }
        }
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        stopSelf();
        if (instance == this) {
            instance = null;
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            notifications.deleteNotificationChannel(LEGACY_CHANNEL_ID);
        } catch (Exception ignored) {
        }
        // DEFAULT：下拉栏里完整展开媒体卡片；声音关掉，避免每次开播响通知音
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "正在播放",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("显示正在播放的歌曲与播放控制");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        notifications.createNotificationChannel(channel);
    }

    /** 没有封面时的兜底大图：应用图标 */
    private Bitmap appIconBitmap() {
        try {
            Bitmap raw = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
            if (raw == null) {
                return null;
            }
            return scaleBitmap(raw, MAX_ARTWORK_PX);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- 封面解码（后台线程调用） ----------

    private static Bitmap decodeArtwork(String url) {
        if (url.startsWith("data:")) {
            int comma = url.indexOf(',');
            if (comma < 0) {
                return null;
            }
            byte[] data = android.util.Base64.decode(url.substring(comma + 1), android.util.Base64.DEFAULT);
            return decodeScaled(data);
        }
        // WebView 本地文件（androidScheme https）形如 https://localhost/_capacitor_file_/storage/...
        int fileMark = url.indexOf("/_capacitor_file_");
        if (fileMark >= 0) {
            return decodeFileScaled(url.substring(fileMark + "/_capacitor_file_".length()));
        }
        if (url.startsWith("file://")) {
            return decodeFileScaled(Uri.parse(url).getPath());
        }
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return decodeHttpScaled(url);
        }
        return null;
    }

    private static Bitmap decodeHttpScaled(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 MusicFreeHy"
            );
            conn.connect();
            if (conn.getResponseCode() != 200) {
                return null;
            }
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int read;
            while ((read = in.read(chunk)) > 0) {
                buffer.write(chunk, 0, read);
                if (buffer.size() > 20 * 1024 * 1024) {
                    return null; // 封面不该有 20MB，防呆
                }
            }
            in.close();
            return decodeScaled(buffer.toByteArray());
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static Bitmap decodeFileScaled(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            if (bounds.outWidth <= 0) {
                return null;
            }
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
            return BitmapFactory.decodeFile(path, opts);
        } catch (Exception e) {
            return null;
        }
    }

    private static Bitmap decodeScaled(byte[] data) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight);
        return BitmapFactory.decodeByteArray(data, 0, data.length, opts);
    }

    /** 采样率：解码结果长边不超过 MAX_ARTWORK_PX 的 2 倍以内 */
    private static int sampleSize(int width, int height) {
        int longEdge = Math.max(width, height);
        if (longEdge <= 0) {
            return 1;
        }
        int size = 1;
        while (longEdge / (size * 2) >= MAX_ARTWORK_PX) {
            size *= 2;
        }
        return size;
    }

    private static Bitmap scaleBitmap(Bitmap source, int maxEdge) {
        int longEdge = Math.max(source.getWidth(), source.getHeight());
        if (longEdge <= maxEdge) {
            return source;
        }
        float ratio = maxEdge / (float) longEdge;
        return Bitmap.createScaledBitmap(
            source,
            Math.max(1, Math.round(source.getWidth() * ratio)),
            Math.max(1, Math.round(source.getHeight() * ratio)),
            true
        );
    }
}
