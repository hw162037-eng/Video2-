import { MaterialIcons } from "@expo/vector-icons";
import { VideoView, useVideoPlayer } from "expo-video";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Image, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { explainError } from "@/lib/agnes-api";
import { useAppStore } from "@/lib/app-store";
import { extractFrameAtTime } from "@/lib/native-work-manager";
import { formatTaskDuration } from "@/lib/task-time";
import { formatTaskDate, STAGE_LABELS, type GenerationTask, type TaskStatus } from "@/lib/types";

const blue = "#45A8FF";
const violet = "#9A7BFF";
const activeStatuses: TaskStatus[] = ["queued", "preparing", "submitting", "processing", "retry_wait"];

function statusColor(status: TaskStatus) {
  if (status === "completed") return "#4FE3A1";
  if (status === "failed") return "#FF7D85";
  if (status === "queued" || status === "retry_wait") return "#FFC36A";
  return blue;
}

function taskAssets(task: GenerationTask) {
  if (task.kind === "image" && task.mode === "text2img") return [];
  if (task.kind === "video" && task.mode === "text") return [];
  return [
    ...(task.imageAssets ?? []),
    ...(task.firstFrame ? [task.firstFrame] : []),
    ...(task.lastFrame ? [task.lastFrame] : []),
    ...(task.kind === "image" && task.mode === "face_swap" && task.targetImage ? [task.targetImage] : []),
    ...(task.kind === "image" && task.mode === "face_swap" && task.faceImage ? [task.faceImage] : []),
  ].filter((asset, index, list) => list.findIndex((item) => item.uri === asset.uri) === index).slice(0, 5);
}

function VideoPreview({ source }: { source: string }) {
  const player = useVideoPlayer(source, (videoPlayer) => {
    videoPlayer.loop = false;
  });
  return <VideoView style={styles.videoPreview} player={player} allowsFullscreen allowsPictureInPicture contentFit="contain" />;
}

function TaskCard({ task, now, developerMode, honestProgress, showTechnicalIds, onRetry, onCancel, onDelete, onPreview, onSave, onContinue }: { task: GenerationTask; now: number; developerMode: boolean; honestProgress: boolean; showTechnicalIds: boolean; onRetry: () => void; onCancel: () => void; onDelete: () => void; onPreview: () => void; onSave: () => void; onContinue: () => void }) {
  const color = statusColor(task.status);
  const active = activeStatuses.includes(task.status);
  const canDelete = ["queued", "completed", "failed", "cancelled"].includes(task.status);
  const duration = task.durationMs ?? (task.startedAt && task.completedAt ? task.completedAt - task.startedAt : task.startedAt ? now - task.startedAt : 0);
  const assets = taskAssets(task);
  return <View style={styles.taskCard}>
    <View style={styles.taskTop}><View style={[styles.kindIcon, { backgroundColor: task.kind === "video" ? "#153A59" : "#342451" }]}><MaterialIcons name={task.kind === "video" ? "movie" : "image"} size={20} color={task.kind === "video" ? blue : violet} /></View><View style={styles.taskMeta}><Text style={styles.taskTitle}>{task.kind === "video" ? "Видео" : "Изображение"} · {task.model}</Text><Text style={styles.taskSub}>{task.profileName} · {formatTaskDate(task.createdAt)}</Text></View><View style={[styles.statusPill, { borderColor: `${color}66`, backgroundColor: `${color}18` }]}><View style={[styles.statusDot, { backgroundColor: color }]} /><Text style={[styles.statusText, { color }]}>{STAGE_LABELS[task.status]}</Text></View></View>
    {assets.length ? <View style={styles.assetStrip}>{assets.map((asset) => <Image key={asset.uri} source={{ uri: asset.uri }} resizeMode="contain" style={styles.assetThumb} />)}</View> : null}
    <Text numberOfLines={2} style={styles.prompt}>{task.prompt || "Без текстового промта"}</Text>
    {task.sourceRatio ? <Text style={styles.taskSub}>Кадр: {task.sourceRatio} → {task.ratio} · {task.fitMode === "crop" ? "обрезка" : task.fitMode === "fill" ? "заполнение" : "сохранение пропорций"}</Text> : null}
    <View style={styles.progressTrack}>{honestProgress && active ? <View style={[styles.progressBar, { width: "42%", backgroundColor: color }]} /> : <View style={[styles.progressBar, { width: `${Math.max(2, task.progress)}%`, backgroundColor: color }]} />}</View>
    <View style={styles.progressRow}><Text style={[styles.stageText, { color }]}>{task.stage}</Text><Text style={styles.percent}>{honestProgress && active ? "ожидание" : `${task.progress}%`}</Text></View>
    {developerMode && showTechnicalIds ? <Text style={styles.taskSub}>task: {task.id}{task.serverId ? ` · server: ${task.serverId}` : ""}</Text> : null}
    <View style={styles.timerRow}><MaterialIcons name="timer" size={14} color={active ? blue : "#4FE3A1"} /><Text style={[styles.timerText, { color: active ? "#A9D9FF" : "#9FECC9" }]}>{active ? `Время генерации: ${formatTaskDuration(duration)}` : `Генерация заняла: ${formatTaskDuration(duration)}`}</Text>{task.completedAt ? <Text style={styles.finishedAt}>до {formatTaskDate(task.completedAt)}</Text> : null}</View>
    {task.errorMessage ? <View style={styles.errorBox}><MaterialIcons name="error-outline" size={16} color="#FF9AA0" /><View style={{ flex: 1 }}><Text style={styles.errorMessage}>{task.errorMessage}</Text><Text style={styles.errorHelp}>{explainError(task)}</Text></View></View> : null}
    <View style={styles.actions}>{task.resultUrl || task.localUri ? <Pressable onPress={onPreview} style={styles.actionButton}><MaterialIcons name="play-circle-outline" size={17} color="#A9D9FF" /><Text style={styles.actionText}>{task.localUri ? "Открыть файл" : "Предпросмотр"}</Text></Pressable> : null}{task.resultUrl && !task.localUri ? <Pressable onPress={onSave} style={styles.actionButton}><MaterialIcons name="save-alt" size={17} color="#4FE3A1" /><Text style={[styles.actionText, { color: "#4FE3A1" }]}>Сохранить на устройство</Text></Pressable> : null}{task.status === "completed" && task.kind === "video" && (task.localUri || task.resultUrl) ? <Pressable onPress={onContinue} style={styles.actionButton}><MaterialIcons name="forward" size={17} color="#C7B8FF" /><Text style={[styles.actionText, { color: "#C7B8FF" }]}>Продолжить</Text></Pressable> : null}{task.localUri ? <Text numberOfLines={1} style={styles.localPath}>сохранено</Text> : null}{task.status === "failed" ? <Pressable onPress={onRetry} style={styles.actionButton}><MaterialIcons name="replay" size={16} color="#FFD28E" /><Text style={styles.actionText}>Повторить</Text></Pressable> : null}{task.status === "queued" ? <Pressable accessibilityLabel="Отменить задачу" onPress={onCancel} style={[styles.iconButton, { marginLeft: "auto", width: 30, height: 30, borderRadius: 10, borderWidth: 1, borderColor: "#7A3442", backgroundColor: "#351D29", alignItems: "center", justifyContent: "center" }]}><MaterialIcons name="close" size={20} color="#FF7D85" /></Pressable> : active ? <Text style={styles.attemptText}>попытки: {task.attempts}</Text> : canDelete ? <Pressable onPress={onDelete} style={styles.iconButton}><MaterialIcons name="delete-outline" size={18} color="#71879A" /></Pressable> : null}</View>
  </View>;
}

function PreviewModal({ task, onClose }: { task: GenerationTask | null; onClose: () => void }) {
  if (!task || (!task.resultUrl && !task.localUri)) return null;
  const isImage = task.kind === "image";
  const source = task.localUri || task.resultUrl || "";
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={styles.previewCard}><View style={styles.previewHeader}><Text style={styles.previewTitle}>{isImage ? "Предпросмотр изображения" : "Готовое видео"}</Text><Pressable onPress={onClose}><MaterialIcons name="close" size={22} color="#AFC4D2" /></Pressable></View>{isImage ? <Image source={{ uri: source }} resizeMode="contain" style={styles.previewImage} /> : <VideoPreview source={source} />}<Text style={styles.previewMeta}>{task.model} · {formatTaskDuration(task.durationMs)}{task.localUri ? " · сохранено локально" : ""}</Text></View></View></Modal>;
}

export default function TasksScreen() {
  const router = useRouter();
  const { tasks, settings, retryTask, cancelTask, removeTask, clearHistory, saveTaskResult, addTask } = useAppStore();
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [now, setNow] = useState(Date.now());
  const [previewTask, setPreviewTask] = useState<GenerationTask | null>(null);
  const [continueTask, setContinueTask] = useState<GenerationTask | null>(null);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [continueSeconds, setContinueSeconds] = useState("0");
  const [continueFrameUri, setContinueFrameUri] = useState<string | undefined>();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const filteredTasks = useMemo(() => filter === "all" ? tasks : filter === "processing" ? tasks.filter((task) => ["preparing", "submitting", "processing", "retry_wait"].includes(task.status)) : tasks.filter((task) => task.status === filter), [tasks, filter]);
  const activeCount = tasks.filter((task) => activeStatuses.includes(task.status)).length;
  const queuedCount = tasks.filter((task) => task.status === "queued").length;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;
  const formatCount = (value: number) => value > 999 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}к` : String(value);
  const statFilters: { key: "all" | "queued" | "processing" | "completed" | "failed" | "cancelled"; label: string; count: number; color: string }[] = [
    { key: "all", label: "все", count: tasks.length, color: violet },
    { key: "queued", label: "очередь", count: queuedCount, color: "#FFC36A" },
    { key: "processing", label: "активны", count: activeCount, color: blue },
    { key: "completed", label: "готово", count: completedCount, color: "#4FE3A1" },
    { key: "failed", label: "ошибки", count: failedCount, color: "#FF7D85" },
    { key: "cancelled", label: "отменены", count: cancelledCount, color: "#A6B2BE" },
  ];
  const openContinue = (task: GenerationTask) => {
    setContinueTask(task);
    setContinuePrompt("");
    setContinueSeconds("0");
    setContinueFrameUri(undefined);
  };

  const chooseContinueFrame = async () => {
    if (!continueTask) return;
    const sourceUri = continueTask.localUri || continueTask.resultUrl;
    if (!sourceUri || Platform.OS === "web") {
      Alert.alert("Недоступно", "Для выбора кадра нужна Android APK-версия и готовое видео.");
      return;
    }
    try {
      const uri = await extractFrameAtTime(sourceUri, continueTask.id, Number(continueSeconds) || 0);
      if (!uri) throw new Error("Нативный модуль кадра недоступен.");
      setContinueFrameUri(uri);
    } catch (error) {
      Alert.alert("Не удалось выбрать кадр", error instanceof Error ? error.message : "Ошибка извлечения кадра.");
    }
  };

  const submitContinue = () => {
    if (!continueTask || !continueFrameUri) { Alert.alert("Выберите кадр", "Сначала укажите секунду и нажмите «Получить кадр»."); return; }
    if (!continuePrompt.trim()) { Alert.alert("Нужен новый промпт", "Опишите, что должно произойти дальше."); return; }
    const now = Date.now();
    const hasAudio = Boolean(continueTask.audioAssets?.length);
    const frame = { uri: continueFrameUri, name: `continue-frame-${now}.png`, mimeType: "image/png" };
    addTask({ ...continueTask, id: `task-${now}-${Math.random().toString(36).slice(2, 7)}`, mode: hasAudio ? "reference_with_audio" : "keyframe", prompt: continuePrompt.trim(), status: "queued", stage: "В очереди на продолжение видео", progress: 0, createdAt: now, updatedAt: now, startedAt: undefined, completedAt: undefined, durationMs: undefined, serverId: undefined, resultUrl: undefined, localUri: undefined, errorCode: undefined, errorMessage: undefined, attempts: 0, imageAssets: hasAudio ? [frame] : undefined, audioAssets: hasAudio ? continueTask.audioAssets : undefined, firstFrame: undefined, lastFrame: hasAudio ? undefined : frame });
    setContinueTask(null);
    setContinueFrameUri(undefined);
    setContinuePrompt("");
  };

  return <ScreenContainer className="p-4" edges={["top", "left", "right"]}>
    <View style={styles.header}><View><Text style={styles.eyebrow}>ОЧЕРЕДЬ ГЕНЕРАЦИЙ</Text><Text style={styles.title}>Задачи</Text></View><Pressable onPress={() => router.push("/")} style={styles.addButton}><MaterialIcons name="add" size={22} color="#07111D" /></Pressable></View>
    <View style={styles.statsRow}>{statFilters.map((item) => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`Фильтр ${item.label}`} onPress={() => setFilter(item.key)} style={[styles.stat, { borderColor: `${item.color}66` }, filter === item.key && { backgroundColor: `${item.color}20`, borderColor: item.color }]}><Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55} style={[styles.statValue, { color: item.color }]}>{formatCount(item.count)}</Text><Text numberOfLines={1} style={styles.statLabel}>{item.label}</Text></Pressable>)}</View>
    {tasks.length > 0 ? <Pressable onPress={() => Alert.alert("Очистить историю", "Удалить завершённые и ошибочные задачи?", [{ text: "Отмена", style: "cancel" }, { text: "Очистить", style: "destructive", onPress: clearHistory }])} style={styles.clearRow}><MaterialIcons name="cleaning-services" size={14} color="#6E8297" /><Text style={styles.clearText}>Очистить историю</Text></Pressable> : null}
    <FlatList data={filteredTasks} keyExtractor={(item) => item.id} showsVerticalScrollIndicator={false} contentContainerStyle={styles.list} ListEmptyComponent={<View style={styles.empty}><View style={styles.emptyIcon}><MaterialIcons name="inbox" size={30} color="#688096" /></View><Text style={styles.emptyTitle}>{tasks.length ? "Нет задач по фильтру" : "Очередь пока пуста"}</Text><Text style={styles.emptyText}>{tasks.length ? "Выберите другой фильтр." : "Создайте фото или видео — здесь будет виден прогресс, ответ сервера и результат."}</Text>{!tasks.length ? <Pressable onPress={() => router.push("/")} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Создать задачу</Text><MaterialIcons name="arrow-forward" size={16} color="#07111D" /></Pressable> : null}</View>} renderItem={({ item }) => <TaskCard task={item} now={now} developerMode={settings.developerMode} honestProgress={settings.honestProgress} showTechnicalIds={settings.showTechnicalIds} onRetry={() => retryTask(item.id)} onCancel={() => Alert.alert("Отменить задачу?", "Задача останется в истории со статусом «Отменена».", [{ text: "Назад", style: "cancel" }, { text: "Отменить", style: "destructive", onPress: () => cancelTask(item.id) }])} onDelete={() => removeTask(item.id)} onPreview={() => setPreviewTask(item)} onSave={() => saveTaskResult(item.id)} onContinue={() => openContinue(item)} />} />
    <PreviewModal task={previewTask} onClose={() => setPreviewTask(null)} />
    <Modal visible={Boolean(continueTask)} transparent animationType="slide" onRequestClose={() => setContinueTask(null)}><View style={styles.modalBackdrop}><View style={styles.continueCard}><View style={styles.previewHeader}><Text style={styles.previewTitle}>Продолжить видео</Text><Pressable onPress={() => setContinueTask(null)}><MaterialIcons name="close" size={22} color="#AFC4D2" /></Pressable></View><Text style={styles.continueHint}>Это ещё не создаёт задачу. Сначала выберите кадр и напишите новый промпт.</Text><Text style={styles.continueLabel}>Кадр на секунде</Text><View style={styles.continueRow}><TextInput value={continueSeconds} onChangeText={setContinueSeconds} keyboardType="decimal-pad" style={styles.continueInput} /><Pressable onPress={() => void chooseContinueFrame()} style={styles.frameButton}><Text style={styles.frameButtonText}>Получить кадр</Text></Pressable></View>{continueFrameUri ? <Image source={{ uri: continueFrameUri }} resizeMode="contain" style={styles.framePreview} /> : null}<Text style={styles.continueLabel}>Новый промпт продолжения</Text><TextInput value={continuePrompt} onChangeText={setContinuePrompt} multiline placeholder="Что должно произойти дальше?" placeholderTextColor="#688096" style={styles.promptInput} />{continueTask?.audioAssets?.length ? <Text style={styles.audioHint}>Аудио исходного видео будет прикреплено автоматически.</Text> : <Text style={styles.audioHint}>У исходного видео аудио не найдено — продолжение будет без аудио.</Text>}<Pressable onPress={submitContinue} style={styles.submitContinue}><Text style={styles.submitContinueText}>Отправить в очередь</Text></Pressable></View></View></Modal>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }, eyebrow: { color: blue, fontSize: 11, fontWeight: "800", letterSpacing: 1.6 }, title: { color: "#F3F8FC", fontSize: 28, fontWeight: "800", marginTop: 5 }, addButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: blue, alignItems: "center", justifyContent: "center" }, statsRow: { flexDirection: "row", gap: 4, marginBottom: 11 }, stat: { flex: 1, minWidth: 0, minHeight: 58, borderRadius: 11, backgroundColor: "#10202E", borderWidth: 1, padding: 4, justifyContent: "center", alignItems: "center" }, statActive: { borderColor: blue, backgroundColor: "#153A59" }, statValue: { color: blue, fontSize: 17, lineHeight: 20, fontWeight: "800" }, statLabel: { color: "#72899D", fontSize: 8, marginTop: 2, fontWeight: "800" }, filterContainer: { height: 54, flexGrow: 0, marginTop: 4, marginBottom: 10, overflow: "hidden" }, filterScroll: { height: 48, flexGrow: 0 }, filterRow: { flexDirection: "row", alignItems: "center", gap: 7, paddingBottom: 6 }, filterChip: { borderWidth: 1, borderColor: "#294154", backgroundColor: "#10202E", paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10 }, filterActive: { borderColor: blue, backgroundColor: "#153A59" }, filterText: { color: "#8499AB", fontSize: 11, fontWeight: "700" }, filterActiveText: { color: "#D9F1FF" }, clearRow: { flexDirection: "row", alignItems: "center", gap: 5, justifyContent: "flex-end", marginBottom: 8 }, clearText: { color: "#71879A", fontSize: 11 }, list: { paddingBottom: 30 }, taskCard: { backgroundColor: "#10202E", borderWidth: 1, borderColor: "#20384B", borderRadius: 17, padding: 14, marginBottom: 10 }, taskTop: { flexDirection: "row", alignItems: "center" }, kindIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", marginRight: 10 }, taskMeta: { flex: 1 }, taskTitle: { color: "#DCEAF3", fontWeight: "800", fontSize: 13 }, taskSub: { color: "#6F879A", fontSize: 10, marginTop: 4 }, statusPill: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 10, paddingVertical: 5, paddingHorizontal: 7, maxWidth: 108 }, statusDot: { width: 5, height: 5, borderRadius: 3 }, statusText: { fontSize: 9, fontWeight: "800", flexShrink: 1 }, assetStrip: { flexDirection: "row", gap: 6, marginTop: 12 }, assetThumb: { width: 52, height: 52, borderRadius: 9, backgroundColor: "#0A1722" }, prompt: { color: "#9BB0C0", fontSize: 12, lineHeight: 17, marginTop: 11 }, progressTrack: { height: 6, borderRadius: 3, backgroundColor: "#203342", marginTop: 14, overflow: "hidden" }, progressBar: { height: 6, borderRadius: 3 }, progressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 6 }, stageText: { fontSize: 11, fontWeight: "700", flex: 1 }, percent: { color: "#DCEAF3", fontSize: 12, fontWeight: "800" }, timerRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8 }, timerText: { fontSize: 11, fontWeight: "800" }, finishedAt: { color: "#71879A", fontSize: 10, marginLeft: "auto" }, errorBox: { flexDirection: "row", gap: 8, backgroundColor: "#341D28", borderRadius: 10, padding: 10, marginTop: 12 }, errorMessage: { color: "#FFB7BC", fontSize: 11, lineHeight: 15 }, errorHelp: { color: "#D38B91", fontSize: 10, lineHeight: 14, marginTop: 3 }, actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 13 }, actionButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 5, maxWidth: "100%" }, actionText: { color: "#A9D9FF", fontSize: 11, fontWeight: "700" }, attemptText: { color: "#72899D", fontSize: 10, marginLeft: "auto" }, localPath: { color: "#6FCDA6", fontSize: 10, maxWidth: 120 }, iconButton: { marginLeft: "auto", padding: 4 }, empty: { alignItems: "center", paddingTop: 50, paddingHorizontal: 28 }, emptyIcon: { width: 66, height: 66, borderRadius: 22, backgroundColor: "#142533", alignItems: "center", justifyContent: "center", marginBottom: 16 }, emptyTitle: { color: "#DCEAF3", fontSize: 18, fontWeight: "800" }, emptyText: { color: "#72899D", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8 }, emptyButton: { marginTop: 18, backgroundColor: blue, borderRadius: 11, minHeight: 42, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 8 }, emptyButtonText: { color: "#07111D", fontWeight: "800", fontSize: 12 }, modalBackdrop: { flex: 1, backgroundColor: "rgba(0,10,18,0.86)", justifyContent: "center", padding: 16 }, previewCard: { backgroundColor: "#10202E", borderRadius: 18, borderWidth: 1, borderColor: "#2B4B62", padding: 14, maxHeight: "90%" }, previewHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }, previewTitle: { color: "#F3F8FC", fontSize: 16, fontWeight: "800" }, previewImage: { width: "100%", height: 360, borderRadius: 12, backgroundColor: "#08131D" }, videoPreview: { height: 260, borderRadius: 12, backgroundColor: "#08131D", alignItems: "center", justifyContent: "center" }, videoPreviewText: { color: "#BBD2E0", fontSize: 12, fontWeight: "700", marginTop: 10 }, previewMeta: { color: "#8FA5B9", fontSize: 11, marginTop: 10 }, openResult: { backgroundColor: blue, borderRadius: 10, minHeight: 42, alignItems: "center", justifyContent: "center", marginTop: 12 }, continueCard: { backgroundColor: "#10202E", borderRadius: 18, borderWidth: 1, borderColor: "#2B4B62", padding: 16, maxHeight: "90%" }, continueHint: { color: "#8FA5B9", fontSize: 11, lineHeight: 16, marginBottom: 12 }, continueLabel: { color: "#BBD2E0", fontSize: 11, fontWeight: "800", marginTop: 9, marginBottom: 6 }, continueRow: { flexDirection: "row", gap: 8 }, continueInput: { flex: 1, minHeight: 43, backgroundColor: "#08131D", borderWidth: 1, borderColor: "#294154", borderRadius: 10, color: "#EDF6FC", paddingHorizontal: 11 }, frameButton: { minHeight: 43, backgroundColor: "#1A4667", borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }, frameButtonText: { color: "#A9D9FF", fontSize: 11, fontWeight: "800" }, framePreview: { width: "100%", height: 170, borderRadius: 10, backgroundColor: "#08131D", marginTop: 10 }, promptInput: { minHeight: 86, backgroundColor: "#08131D", borderWidth: 1, borderColor: "#294154", borderRadius: 10, color: "#EDF6FC", padding: 11, textAlignVertical: "top" }, audioHint: { color: "#79A98F", fontSize: 10, lineHeight: 14, marginTop: 8 }, submitContinue: { minHeight: 44, backgroundColor: blue, borderRadius: 11, alignItems: "center", justifyContent: "center", marginTop: 12 }, submitContinueText: { color: "#07111D", fontSize: 12, fontWeight: "900" }, openResultText: { color: "#07111D", fontSize: 12, fontWeight: "900" },
});
