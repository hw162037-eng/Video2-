import { MaterialIcons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useAppStore } from "@/lib/app-store";
import { IMAGE_RATIO_OPTIONS, imageRatioLabel, nearestImageRatio } from "@/lib/image-ratio";
import type { FileAsset, GenerationKind, GenerationTask } from "@/lib/types";

const blue = "#45A8FF";
const violet = "#9A7BFF";

function Chip({ label, active, onPress, tone = "blue" }: { label: string; active: boolean; onPress: () => void; tone?: "blue" | "violet" }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, active && { backgroundColor: tone === "blue" ? "#153A59" : "#342451", borderColor: tone === "blue" ? blue : violet }, pressed && styles.pressed]}><Text style={[styles.chipText, active && { color: tone === "blue" ? "#B9E1FF" : "#E4D9FF" }]}>{label}</Text></Pressable>;
}

function SectionTitle({ icon, title, hint }: { icon: keyof typeof MaterialIcons.glyphMap; title: string; hint?: string }) {
  return <View style={styles.sectionTitle}><View style={styles.sectionIcon}><MaterialIcons name={icon} size={16} color={blue} /></View><Text style={styles.sectionLabel}>{title}</Text>{hint ? <Text style={styles.sectionHint}>{hint}</Text> : null}</View>;
}

function AssetPreviewRow({ assets }: { assets: FileAsset[] }) {
  if (!assets.length) return null;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.assetPreviewRow}>{assets.map((asset) => <Image key={asset.uri} source={{ uri: asset.uri }} style={styles.assetPreview} />)}</ScrollView>;
}

export default function HomeScreen() {
  const { profiles, sharedImgbbKey, addTask } = useAppStore();
  const [kind, setKind] = useState<GenerationKind>("video");
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id ?? "");
  const [videoModel, setVideoModel] = useState("agnes-video-2.5-flash");
  const [videoMode, setVideoMode] = useState("text");
  const [imageModel, setImageModel] = useState("agnes-image-2.5-flash");
  const [imageMode, setImageMode] = useState("text2img");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState("12");
  const [size, setSize] = useState("720P");
  const [ratio, setRatio] = useState("16:9");
  const [autoRatio, setAutoRatio] = useState(true);
  const [fitMode, setFitMode] = useState<"preserve" | "crop" | "fill">("preserve");
  const [seed, setSeed] = useState("");
  const [imageAssets, setImageAssets] = useState<FileAsset[]>([]);
  const [audioAssets, setAudioAssets] = useState<FileAsset[]>([]);
  const [firstFrame, setFirstFrame] = useState<FileAsset | undefined>();
  const [lastFrame, setLastFrame] = useState<FileAsset | undefined>();
  const [targetImage, setTargetImage] = useState<FileAsset | undefined>();
  const [faceImage, setFaceImage] = useState<FileAsset | undefined>();
  const [justQueued, setJustQueued] = useState(false);

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0], [profiles, selectedProfileId]);
  const isFlash = videoModel === "agnes-video-2.5-flash";
  const maxVideoSeconds = isFlash ? 12 : size === "1080P" ? 10 : 15;
  const quickDurations = [...new Set([5, 10, maxVideoSeconds])];
  const sourceAsset = imageMode === "face_swap" ? targetImage : imageAssets[0];
  const detectedSourceRatio = nearestImageRatio(sourceAsset?.width, sourceAsset?.height);
  const effectiveImageRatio = kind === "image" && autoRatio && detectedSourceRatio ? detectedSourceRatio : ratio;
  const legacyImageSize = (value: string) => value === "1:1" ? "1024x1024" : ["9:16", "3:4"].includes(value) ? "768x1024" : "1024x768";

  const selectImages = async (multiple = true) => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Нужен доступ к фото", "Разрешите выбрать референсное изображение в настройках Android.");
      return [];
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: multiple, selectionLimit: multiple ? 5 : 1, quality: 1 });
    if (result.canceled) return [];
    return result.assets.map((asset) => ({ uri: asset.uri, name: asset.fileName ?? `image-${Date.now()}.jpg`, mimeType: asset.mimeType, size: asset.fileSize, width: asset.width, height: asset.height }));
  };

  const selectAudio = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: "audio/*", multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    setAudioAssets(result.assets.slice(0, 3).map((asset) => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size })));
  };

  const createTask = () => {
    if (!selectedProfile) {
      Alert.alert("Нет профиля", "Добавьте и включите профиль Agnes AI в настройках.");
      return;
    }
    if (!selectedProfile.agnesKey) {
      Alert.alert("Нет Agnes AI API key", "Откройте Настройки → Профили API и добавьте ключ.");
      return;
    }
    if (!prompt.trim()) {
      Alert.alert("Нужен промт", "Опишите, что нужно сгенерировать.");
      return;
    }
    if (kind === "video" && videoMode === "keyframe" && !firstFrame && !lastFrame) {
      Alert.alert("Добавьте кадр", "Для keyframe нужен начальный или конечный кадр.");
      return;
    }
    if (kind === "image" && imageMode === "multi_ref" && imageAssets.length < 2) {
      Alert.alert("Нужны референсы", "Для multi_ref выберите минимум два изображения.");
      return;
    }
    if (kind === "image" && imageMode === "face_swap" && (!targetImage || !faceImage)) {
      Alert.alert("Нужны два изображения", "Выберите основу и изображение лица.");
      return;
    }

    const taskPrompt = kind === "image" && imageMode !== "text2img" ? `${prompt.trim()}\n\n[Image framing: ${fitMode === "preserve" ? "preserve original proportions without stretching" : fitMode === "crop" ? "crop edges to fill the selected frame without stretching" : "fill the selected frame without stretching the subject"}]` : prompt.trim();
    const task: GenerationTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      profileId: selectedProfile.id,
      profileName: selectedProfile.name,
      model: kind === "video" ? videoModel : imageModel,
      mode: kind === "video" ? videoMode : imageMode,
      prompt: taskPrompt,
      status: "queued",
      stage: "В очереди на отправку",
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      seconds: kind === "video" ? Number(seconds) || 5 : undefined,
      size: kind === "video" ? size : imageModel === "agnes-image-2.0-flash" ? legacyImageSize(effectiveImageRatio) : "1K",
      ratio: kind === "video" ? ratio : effectiveImageRatio,
      sourceRatio: kind === "image" ? detectedSourceRatio : undefined,
      fitMode: kind === "image" ? fitMode : undefined,
      seed: seed.trim() ? Number(seed) : undefined,
      imageAssets: kind === "video" ? (imageAssets.length ? imageAssets : undefined) : (imageMode !== "text2img" && imageAssets.length ? imageAssets : undefined),
      audioAssets: kind === "video" && audioAssets.length ? audioAssets : undefined,
      firstFrame: kind === "video" ? firstFrame : undefined,
      lastFrame: kind === "video" ? lastFrame : undefined,
      targetImage: kind === "image" && imageMode === "face_swap" ? targetImage : undefined,
      faceImage: kind === "image" && imageMode === "face_swap" ? faceImage : undefined,
    };
    addTask(task);
    setJustQueued(true);
    setTimeout(() => setJustQueued(false), 1000);
  };

  const setVideoDefaults = (next: string) => {
    setVideoModel(next);
    setPrompt("");
    if (next === "agnes-video-2.5-flash") {
      setSize("720P");
      setSeconds("12");
    } else {
      setSeconds(size === "1080P" ? "10" : "15");
    }
    if (next === "agnes-video-v2.0" && videoMode === "reference_with_audio") setVideoMode("reference_no_audio");
  };

  const setVideoModeAndClearPrompt = (next: string) => {
    setVideoMode(next);
    setPrompt("");
  };

  const setImageModeAndPrompt = (next: string) => {
    setImageMode(next);
    setImageAssets([]);
    setTargetImage(undefined);
    setFaceImage(undefined);
    setFitMode("preserve");
    setPrompt(next === "face_swap" ? "Use [Image 1] as the base, but replace the face with the face from [Image 2]. Preserve pose, clothes, lighting and background." : "");
  };

  const choosePhotoImages = async (multiple: boolean) => {
    const assets = await selectImages(multiple);
    setImageAssets(assets);
    const detected = nearestImageRatio(assets[0]?.width, assets[0]?.height);
    if (detected) { setRatio(detected); setAutoRatio(true); }
  };

  const chooseFaceTarget = async () => {
    const asset = (await selectImages(false))[0];
    if (asset) {
      setTargetImage(asset);
      const detected = nearestImageRatio(asset.width, asset.height);
      if (detected) { setRatio(detected); setAutoRatio(true); }
    }
  };

  const chooseVideoImages = async () => setImageAssets(await selectImages(true));
  const chooseKeyframe = async (which: "first" | "last") => {
    const assets = await selectImages(false);
    if (assets[0]) {
      if (which === "first") setFirstFrame(assets[0]);
      else setLastFrame(assets[0]);
    }
  };

  return (
    <ScreenContainer className="p-4" edges={["top", "left", "right"]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.headerRow}><View><Text style={styles.eyebrow}>AGNES AI STUDIO</Text><Text style={styles.title}>Создать генерацию</Text></View><View style={styles.freeBadge}><View style={styles.liveDot} /><Text style={styles.freeText}>FREE API</Text></View></View>
        <Text style={styles.subtitle}>Очередь работает по профилям: фото и видео одного ключа могут идти одновременно.</Text>

        <View style={styles.segmented}><Pressable onPress={() => { setKind("video"); setPrompt(""); setImageAssets([]); setAudioAssets([]); setFirstFrame(undefined); setLastFrame(undefined); setTargetImage(undefined); setFaceImage(undefined); setFitMode("preserve"); }} style={[styles.segment, kind === "video" && styles.segmentVideo]}><MaterialIcons name="movie" size={18} color={kind === "video" ? "#D9F1FF" : "#7891A8"} /><Text style={[styles.segmentText, kind === "video" && styles.segmentActiveText]}>Видео</Text></Pressable><Pressable onPress={() => { setKind("image"); setPrompt(""); setImageAssets([]); setAudioAssets([]); setFirstFrame(undefined); setLastFrame(undefined); setTargetImage(undefined); setFaceImage(undefined); setFitMode("preserve"); }} style={[styles.segment, kind === "image" && styles.segmentImage]}><MaterialIcons name="image" size={18} color={kind === "image" ? "#EEE7FF" : "#7891A8"} /><Text style={[styles.segmentText, kind === "image" && styles.segmentActiveText]}>Фото</Text></Pressable></View>

        <View style={styles.card}>
          <SectionTitle icon="account-circle" title="Профиль API" hint="локально" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>{profiles.filter((profile) => profile.enabled).map((profile) => <Chip key={profile.id} label={profile.name} active={selectedProfile?.id === profile.id} onPress={() => setSelectedProfileId(profile.id)} />)}</ScrollView>
          {!profiles.some((profile) => profile.enabled) ? <Text style={styles.warningText}>Нет включённых профилей. Добавьте ключ в Настройках.</Text> : <Text style={styles.mutedText}>Лимит Free: видео 1 фактический RPM · изображения зависят от разрешения.</Text>}
        </View>

        {kind === "video" ? <View style={styles.card}>
          <SectionTitle icon="movie" title="Параметры видео" hint={isFlash ? "прямая отправка" : "через ImgBB"} />
          <Text style={styles.fieldLabel}>Модель</Text>
          <View style={styles.chipWrap}><Chip label="Agnes Video 2.5 Flash" active={isFlash} onPress={() => setVideoDefaults("agnes-video-2.5-flash")} /><Chip label="Agnes Video V2.0" active={!isFlash} onPress={() => setVideoDefaults("agnes-video-v2.0")} /></View>
          <Text style={styles.fieldLabel}>Режим</Text>
          <View style={styles.chipWrap}><Chip label="Только текст" active={videoMode === "text"} onPress={() => setVideoModeAndClearPrompt("text")} /><Chip label="Reference" active={videoMode === "reference_no_audio"} onPress={() => setVideoModeAndClearPrompt("reference_no_audio")} /><Chip label="Keyframe" active={videoMode === "keyframe"} onPress={() => setVideoModeAndClearPrompt("keyframe")} />{isFlash ? <Chip label="Reference + audio" active={videoMode === "reference_with_audio"} onPress={() => setVideoModeAndClearPrompt("reference_with_audio")} /> : null}</View>
          {(videoMode === "reference_no_audio" || videoMode === "reference_with_audio") ? <><Pressable onPress={chooseVideoImages} style={styles.uploadBox}><MaterialIcons name="add-photo-alternate" size={24} color={blue} /><Text style={styles.uploadTitle}>{imageAssets.length ? `${imageAssets.length} изображений выбрано` : "Добавить референсы"}</Text><Text style={styles.uploadHint}>{isFlash ? "до 5 · Base64 напрямую в Agnes AI" : `первое изображение загрузится в ImgBB${sharedImgbbKey ? " · ключ задан" : " · ключ не задан"}`}</Text></Pressable><AssetPreviewRow assets={imageAssets} /></> : null}
          {videoMode === "reference_with_audio" && isFlash ? <Pressable onPress={selectAudio} style={[styles.uploadBox, { borderColor: "#7454B8" }]}><MaterialIcons name="audiotrack" size={24} color={violet} /><Text style={styles.uploadTitle}>{audioAssets.length ? `${audioAssets.length} аудиофайла выбрано` : "Добавить аудио-референс"}</Text><Text style={styles.uploadHint}>MP3, WAV, AAC · максимум 3</Text></Pressable> : null}
          {videoMode === "keyframe" ? <><View style={styles.twoCol}><Pressable onPress={() => chooseKeyframe("first")} style={styles.smallUpload}><MaterialIcons name="first-page" size={20} color={blue} /><Text style={styles.smallUploadText}>{firstFrame ? "Начальный кадр ✓" : "Начальный кадр"}</Text></Pressable><Pressable onPress={() => chooseKeyframe("last")} style={[styles.smallUpload, { borderColor: violet }]}><MaterialIcons name="last-page" size={20} color={violet} /><Text style={styles.smallUploadText}>{lastFrame ? "Конечный кадр ✓" : "Конечный кадр"}</Text></Pressable></View><AssetPreviewRow assets={[firstFrame, lastFrame].filter((asset): asset is FileAsset => Boolean(asset))} /></> : null}
          <Text style={styles.fieldLabel}>Промт</Text><TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="Опишите сцену, движение и стиль" placeholderTextColor="#688096" style={[styles.input, styles.promptInput]} />
          <View style={styles.twoCol}><View style={styles.flexCol}><Text style={styles.fieldLabel}>Секунды <Text style={styles.optional}>(макс. {maxVideoSeconds})</Text></Text><TextInput value={seconds} onChangeText={(value) => setSeconds(value.replace(/\D/g, "").slice(0, 2))} onBlur={() => setSeconds(String(Math.min(Math.max(1, Number(seconds) || 1), maxVideoSeconds)))} maxLength={2} keyboardType="number-pad" style={styles.input} /><View style={[styles.compactChips, { marginTop: 7, flexWrap: "wrap" }]}>{quickDurations.map((value) => <Chip key={value} label={`${value}с`} active={Number(seconds) === value} onPress={() => setSeconds(String(value))} />)}</View></View><View style={styles.flexCol}><Text style={styles.fieldLabel}>Разрешение</Text><View style={styles.compactChips}><Chip label="720P" active={size === "720P"} onPress={() => { setSize("720P"); if (!isFlash) setSeconds("15"); }} />{!isFlash ? <Chip label="1080P" active={size === "1080P"} onPress={() => { setSize("1080P"); setSeconds("10"); }} /> : null}</View></View></View>
          <Text style={styles.fieldLabel}>Соотношение сторон</Text><View style={styles.chipWrap}>{["16:9", "9:16", "1:1", "4:3", "21:9"].map((item) => <Chip key={item} label={item} active={ratio === item} onPress={() => setRatio(item)} />)}</View>
          <Text style={styles.fieldLabel}>Seed <Text style={styles.optional}>(необязательно)</Text></Text><TextInput value={seed} onChangeText={setSeed} keyboardType="number-pad" placeholder="Случайный" placeholderTextColor="#688096" style={styles.input} />
        </View> : <View style={styles.card}>
          <SectionTitle icon="image" title="Параметры фото" hint="/images/generations" />
          <Text style={styles.fieldLabel}>Модель</Text><View style={styles.chipWrap}><Chip label="Image 2.5 Flash" active={imageModel === "agnes-image-2.5-flash"} onPress={() => setImageModel("agnes-image-2.5-flash")} tone="violet" /><Chip label="Image 2.1 Flash" active={imageModel === "agnes-image-2.1-flash"} onPress={() => setImageModel("agnes-image-2.1-flash")} tone="violet" /><Chip label="Image 2.0 Flash" active={imageModel === "agnes-image-2.0-flash"} onPress={() => setImageModel("agnes-image-2.0-flash")} tone="violet" /></View>
          <Text style={styles.fieldLabel}>Режим</Text><View style={styles.chipWrap}>{[["text2img", "Text → image"], ["img2img", "Img → image"], ["multi_ref", "Multi reference"], ["face_swap", "Face swap"]].map(([value, label]) => <Chip key={value} label={label} active={imageMode === value} onPress={() => setImageModeAndPrompt(value)} tone="violet" />)}</View>
          {imageMode === "img2img" || imageMode === "multi_ref" ? <><Pressable onPress={() => choosePhotoImages(imageMode === "multi_ref")} style={[styles.uploadBox, { borderColor: "#7454B8" }]}><MaterialIcons name="collections" size={24} color={violet} /><Text style={styles.uploadTitle}>{imageAssets.length ? `${imageAssets.length} изображений выбрано` : "Добавить исходные изображения"}</Text><Text style={styles.uploadHint}>{imageMode === "multi_ref" ? "2–5 изображений · Base64 или ImgBB" : "1 изображение · пропорции по оригиналу"}</Text></Pressable><AssetPreviewRow assets={imageAssets} /></> : null}
          {imageMode === "face_swap" ? <><View style={styles.twoCol}><Pressable onPress={chooseFaceTarget} style={[styles.smallUpload, { borderColor: violet }]}><MaterialIcons name="crop-original" size={20} color={violet} /><Text style={styles.smallUploadText}>{targetImage ? "Основа ✓" : "Основа"}</Text></Pressable><Pressable onPress={async () => setFaceImage((await selectImages(false))[0])} style={[styles.smallUpload, { borderColor: violet }]}><MaterialIcons name="face" size={20} color={violet} /><Text style={styles.smallUploadText}>{faceImage ? "Лицо ✓" : "Лицо"}</Text></Pressable></View><AssetPreviewRow assets={[targetImage, faceImage].filter((asset): asset is FileAsset => Boolean(asset))} /></> : null}
          <Text style={styles.fieldLabel}>Промт</Text><TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="Опишите стиль, композицию и изменения" placeholderTextColor="#688096" style={[styles.input, styles.promptInput]} />
          <Text style={styles.fieldLabel}>Соотношение сторон {sourceAsset ? <Text style={styles.optional}>({autoRatio && detectedSourceRatio ? `авто ${imageRatioLabel(sourceAsset.width, sourceAsset.height)}` : "ручное"})</Text> : null}</Text><View style={styles.chipWrap}>{IMAGE_RATIO_OPTIONS.map((item) => <Chip key={item} label={item} active={effectiveImageRatio === item} onPress={() => { setAutoRatio(false); setRatio(item); if (detectedSourceRatio && item !== detectedSourceRatio) setFitMode("crop"); }} tone="violet" />)}</View>{sourceAsset ? <View style={styles.twoCol}><Pressable onPress={() => { if (detectedSourceRatio) setRatio(detectedSourceRatio); setAutoRatio(true); setFitMode("preserve"); }} style={[styles.smallUpload, autoRatio && { borderColor: violet }]}><MaterialIcons name="aspect-ratio" size={18} color={violet} /><Text style={styles.smallUploadText}>Сохранить пропорции</Text></Pressable><View style={styles.flexCol}><Text style={styles.fieldLabel}>Кадр</Text><View style={styles.compactChips}><Chip label="Обрезать" active={fitMode === "crop"} onPress={() => setFitMode("crop")} tone="violet" /><Chip label="Заполнить" active={fitMode === "fill"} onPress={() => setFitMode("fill")} tone="violet" /></View></View></View> : null}
          <Text style={styles.caption}><MaterialIcons name="info-outline" size={14} color="#8FA5B9" /> {imageModel === "agnes-image-2.0-flash" ? "Модель 2.0 принимает точные размеры 1024x1024 / 1024x768 / 768x1024." : `Модель ${imageModel === "agnes-image-2.5-flash" ? "2.5" : "2.1"} использует размер 1K и выбранное соотношение сторон.`}</Text>
        </View>}

        <Pressable onPress={createTask} style={({ pressed }) => [styles.primaryButton, kind === "image" && styles.imageButton, justQueued && styles.queuedButton, pressed && styles.buttonPressed]}><MaterialIcons name={justQueued ? "check" : "bolt"} size={21} color="#07111D" /><Text style={styles.primaryButtonText}>{justQueued ? "Задача поставлена" : "Поставить в очередь"}</Text><View style={styles.buttonArrow}><MaterialIcons name={justQueued ? "done" : "arrow-forward"} size={18} color="#07111D" /></View></Pressable>
        <View style={styles.footerNote}><MaterialIcons name="security" size={14} color="#6E8297" /><Text style={styles.footerText}>Ключи сохраняются только локально на устройстве. ImgBB — общий ключ в настройках.</Text></View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: 36 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  eyebrow: { color: blue, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: "#F3F8FC", fontSize: 28, fontWeight: "800", marginTop: 5, letterSpacing: -0.5 },
  subtitle: { color: "#8FA5B9", fontSize: 13, lineHeight: 19, marginBottom: 18, maxWidth: 350 },
  freeBadge: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#285276", borderRadius: 18, paddingVertical: 7, paddingHorizontal: 10, backgroundColor: "#10293F" },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#4FE3A1", marginRight: 6 },
  freeText: { color: "#A9D9FF", fontSize: 10, fontWeight: "800", letterSpacing: 0.6 },
  segmented: { flexDirection: "row", padding: 4, borderRadius: 14, backgroundColor: "#111F2C", borderWidth: 1, borderColor: "#203547", marginBottom: 14 },
  segment: { flex: 1, minHeight: 44, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  segmentVideo: { backgroundColor: "#153A59" }, segmentImage: { backgroundColor: "#342451" }, segmentText: { color: "#7D93A7", fontWeight: "700", fontSize: 14 }, segmentActiveText: { color: "#EEF7FF" },
  card: { backgroundColor: "#10202E", borderRadius: 18, borderWidth: 1, borderColor: "#20384B", padding: 16, marginBottom: 14 },
  sectionTitle: { flexDirection: "row", alignItems: "center", marginBottom: 13 }, sectionIcon: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#142E44", marginRight: 9 }, sectionLabel: { color: "#E6F0F7", fontSize: 16, fontWeight: "800" }, sectionHint: { color: "#668198", fontSize: 11, marginLeft: "auto" },
  chipRow: { gap: 8, paddingBottom: 3 }, chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 3 }, compactChips: { flexDirection: "row", gap: 7 }, chip: { minHeight: 36, borderRadius: 10, paddingHorizontal: 11, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: "#294154", backgroundColor: "#142533" }, chipText: { color: "#91A7BA", fontSize: 12, fontWeight: "700" }, pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] }, mutedText: { color: "#72899D", fontSize: 11, marginTop: 10, lineHeight: 16 }, warningText: { color: "#FFC36A", fontSize: 12, marginTop: 7 },
  fieldLabel: { color: "#A8BBCB", fontSize: 12, fontWeight: "700", marginTop: 13, marginBottom: 7 }, optional: { color: "#687F93", fontWeight: "400" }, input: { minHeight: 45, borderRadius: 11, backgroundColor: "#0A1722", borderWidth: 1, borderColor: "#294154", paddingHorizontal: 12, color: "#EDF6FC", fontSize: 14 }, promptInput: { minHeight: 104, paddingTop: 12, textAlignVertical: "top", lineHeight: 20 }, twoCol: { flexDirection: "row", gap: 10, marginTop: 4 }, flexCol: { flex: 1 },
  uploadBox: { minHeight: 88, borderRadius: 13, borderWidth: 1, borderStyle: "dashed", borderColor: blue, backgroundColor: "#0C1A27", alignItems: "center", justifyContent: "center", marginTop: 12, padding: 12 }, uploadTitle: { color: "#DCECF8", fontSize: 13, fontWeight: "700", marginTop: 5 }, uploadHint: { color: "#71899D", fontSize: 10, marginTop: 3, textAlign: "center" }, assetPreviewRow: { gap: 8, paddingTop: 10 }, assetPreview: { width: 70, height: 70, borderRadius: 10, backgroundColor: "#0A1722" }, smallUpload: { flex: 1, minHeight: 68, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: blue, alignItems: "center", justifyContent: "center", backgroundColor: "#0C1A27", marginTop: 12 }, smallUploadText: { color: "#C2D5E2", fontSize: 11, fontWeight: "700", marginTop: 5 }, caption: { color: "#7D94A7", fontSize: 11, lineHeight: 16, marginTop: 15 },
  primaryButton: { minHeight: 56, borderRadius: 15, backgroundColor: blue, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginTop: 2, shadowColor: blue, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 7 }, elevation: 5 }, imageButton: { backgroundColor: violet, shadowColor: violet }, queuedButton: { backgroundColor: "#4FE3A1", shadowColor: "#4FE3A1" }, buttonPressed: { opacity: 0.8, transform: [{ scale: 0.985 }] }, primaryButtonText: { color: "#07111D", fontSize: 15, fontWeight: "900" }, buttonArrow: { position: "absolute", right: 15, width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.28)", alignItems: "center", justifyContent: "center" }, footerNote: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 13 }, footerText: { color: "#61788D", fontSize: 10, textAlign: "center" },
});
