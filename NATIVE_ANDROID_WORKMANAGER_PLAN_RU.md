# План перехода Agnes AI Studio Mobile на нативный Android

## 1. Цель и границы

Целью является перенос фоновой части приложения из Expo-прототипа в нативный Android-модуль на Kotlin. Приложение должно продолжать генерации после сворачивания интерфейса, переживать закрытие Activity, восстанавливать очередь после перезапуска устройства, сохранять результаты через MediaStore и показывать пользователю понятные уведомления о ходе и завершении задач.

Нативный слой будет отвечать за выполнение задач, сетевые запросы, ограничение частоты запросов, сохранение результатов и уведомления. UI Android Studio будет отображать состояние локальной базы данных и передавать новые задачи в очередь.

> Важно: WorkManager не отменяет системные ограничения Android полностью. Для длинной работы WorkManager запускает foreground service и показывает постоянное уведомление. Для Android 14+ необходимо объявить тип foreground service и передавать его при создании ForegroundInfo. Для Android 15+ тип `dataSync` имеет суммарное ограничение работы в фоне до 6 часов за 24 часа. [1] [4]

## 2. Рекомендуемый стек

| Область | Решение |
|---|---|
| Язык | Kotlin |
| Среда | Android Studio |
| Java | JDK 21, который уже запрашивает Android Studio |
| Минимальная версия | Android 10, API 29 |
| Целевая версия | актуальный SDK проекта, не ниже API 35 после проверки зависимостей |
| Фоновые задачи | WorkManager + CoroutineWorker |
| Долгие задачи | ForegroundInfo с типом `dataSync` |
| HTTP | Retrofit + OkHttp + Kotlin Serialization или Moshi |
| Локальная база | Room |
| Секреты | Android Keystore через EncryptedSharedPreferences или encrypted DataStore |
| Файлы галереи | MediaStore |
| UI | Jetpack Compose или существующий Expo UI через постепенную миграцию |
| Уведомления | NotificationCompat и отдельные Android notification channels |

## 3. Архитектура

Приложение следует разделить на четыре слоя.

**UI-слой** показывает форму создания, список задач, профили и настройки. Он не выполняет polling и не содержит API-ключи в открытом виде.

**Domain-слой** содержит правила очереди, ограничения Free, backoff, проверку допустимых параметров и преобразование пользовательской задачи в сетевой запрос.

**Data-слой** содержит Room DAO, Retrofit API, хранилище ключей, MediaStore saver и репозиторий генераций.

**Background-слой** содержит WorkManager Workers, foreground notification, отмену задач, восстановление после reboot и переходы статусов.

Основной поток будет выглядеть так:

```text
UI → Room: создать GenerationTask
UI → WorkManager: enqueueUniqueWork(taskId)
Worker → Room: preparing/submitting/processing
Worker → Agnes API: submit + polling
Worker → MediaStore: сохранить PNG или MP4
Worker → Room: completed/failed
Worker → NotificationManager: уведомить пользователя
```

## 4. Модель данных Room

Нужно создать следующие сущности.

### ApiProfileEntity

Поля: `id`, `name`, `agnesKeyRef`, `enabled`, `createdAt`, `updatedAt`. Сам ключ не хранится в открытом поле Room. В базе хранится ссылка на запись Android Keystore.

### AppSettingsEntity

Поля: `pollIntervalSec`, `minImageIntervalSec`, `minVideoIntervalSec`, `retryBaseSec`, `maxAutoRetries`, `autoContinue`, `notifications`, `soundOnComplete`.

### GenerationTaskEntity

Поля: `id`, `profileId`, `profileNameSnapshot`, `kind`, `model`, `mode`, `prompt`, `seconds`, `size`, `ratio`, `sourceRatio`, `fitMode`, `status`, `stage`, `progress`, `serverId`, `resultUrl`, `localUri`, `errorCode`, `errorMessage`, `attempts`, `createdAt`, `startedAt`, `completedAt`, `durationMs`, `updatedAt`.

Исходные файлы нельзя хранить только как временные URI из picker. Для каждой задачи нужно копировать входной файл в `filesDir/tasks/<taskId>/input/` и хранить стабильный локальный путь. Это предотвращает потерю файла после перезапуска приложения.

Статусы: `QUEUED`, `PREPARING`, `SUBMITTING`, `PROCESSING`, `RETRY_WAIT`, `COMPLETED`, `FAILED`, `CANCELLED`.

## 5. Очередь WorkManager

Каждая пользовательская задача получает уникальное имя:

```text
agnes-task-{taskId}
```

Для запуска используется `OneTimeWorkRequest` и `ExistingWorkPolicy.KEEP`. Это исключает повторную постановку одной задачи при повторном нажатии или восстановлении интерфейса.

Для каждого профиля должны действовать два независимых слота:

- один слот для фото;
- один слот для видео.

Это позволяет одновременно выполнять одну фото- и одну видеогенерацию на одном API-профиле, но не превышать правило пользователя «один ключ — одна фото и одна видео одновременно».

Перед отправкой Worker получает блокировку профиля и типа генерации через Room-транзакцию. Если слот занят, Worker возвращает `Result.retry()` с задержкой, рассчитанной по настройке профиля. Для разных профилей блокировки независимы.

После завершения текущей задачи Worker освобождает слот и запускает следующую задачу того же профиля и типа, если включён `autoContinue`.

## 6. Foreground Worker

Основной класс: `GenerationWorker : CoroutineWorker`.

В начале `doWork()` Worker обязан вызвать `setForeground(createForegroundInfo(...))`. Уведомление должно быть создано до сетевого запроса и содержать название модели, профиль, текущий этап, процент и действие «Отменить».

Примерная последовательность:

```text
setForeground("Подготовка", 0%)
проверить отмену
получить профиль и ключи
проверить rate limit профиля
создать payload
setForeground("Отправка", 10%)
отправить запрос
сохранить serverId
polling до готовности
setForeground("Генерация", progress%)
скачать результат во временный файл
сохранить через MediaStore
записать completed в Room
показать звуковое уведомление
```

В Worker необходимо регулярно проверять `isStopped` и `coroutineContext.ensureActive()`. При отмене нужно отменить HTTP-запрос, удалить временный файл и записать `CANCELLED`.

Для Android 14+ в manifest потребуется `android:foregroundServiceType="dataSync"`, permission `FOREGROUND_SERVICE` и `FOREGROUND_SERVICE_DATA_SYNC`. При создании `ForegroundInfo` нужно передавать `ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC`. Эти требования установлены официальной документацией Android. [3]

## 7. API, polling и ограничения Free

API-клиент должен быть единым для всех режимов, но payload builders должны оставаться разделёнными:

| Группа | Режимы |
|---|---|
| Видео | `text`, `reference`, `keyframe`, `reference_with_audio` |
| Фото | `text2img`, `img2img`, `multi_ref`, `face_swap` |
| ImgBB | загрузка только тех входных файлов, которым нужен публичный URL |

Нужно использовать отдельный `ProfileRateLimiter` для каждого профиля. Он хранит время последней отправки по типам фото и видео, количество неудачных попыток и время следующего разрешённого запроса.

Polling должен выполняться только после успешного получения server task id. Интервал берётся из настроек, но ограничивается безопасным минимумом, например не меньше 5 секунд. Ошибки 429, 408, 500, 502, 503 и 504 должны использовать exponential backoff с верхним пределом. Ответы API нужно сохранять в `errorCode`, `errorMessage` и `rawResponseSummary`, чтобы пользователь видел расшифровку ошибки.

Нельзя считать завершением HTTP 200 при создании задачи. Завершение определяется только финальным статусом сервера и наличием результата.

## 8. Исправление фото/видео состояния

В нативной модели нужно запретить общий mutable-state формы для всех режимов. При создании `GenerationTask` должны копироваться только релевантные поля.

Для `image + text2img` запрещены `imageAssets`, `firstFrame`, `lastFrame`, `targetImage`, `faceImage`, `sourceRatio` и `fitMode`.

Для `video + text` запрещены изображения и аудио.

Для `video + reference` разрешены только reference images.

Для `video + keyframe` разрешены только first/last frame.

Для `image + face_swap` разрешены только target image и face image.

Карточка задачи должна строить preview по `task.kind`, а не по наличию случайного поля asset. Фото всегда открываются через Image composable, видео — через ExoPlayer/Media3. Входные изображения и итоговый результат должны отображаться разными секциями.

## 9. Сохранение через MediaStore

После скачивания результата Worker сначала пишет файл во временный файл приложения. Затем он создаёт запись в соответствующей коллекции MediaStore:

- изображение: `MediaStore.Images.Media.EXTERNAL_CONTENT_URI` и `Pictures/Agnes-AI`;
- видео: `MediaStore.Video.Media.EXTERNAL_CONTENT_URI` и `Movies/Agnes-AI`.

Для Android 10+ следует использовать `RELATIVE_PATH` и `IS_PENDING=1`, записать содержимое через `ContentResolver`, а затем выставить `IS_PENDING=0`. Пока файл находится в pending-состоянии, другие приложения его не видят. Официальная документация рекомендует этот механизм для длительной записи медиаконтента. [2]

Такой путь не должен каждый раз открывать диалог изменения уже существующего файла. Приложение создаёт новый собственный media item, а не редактирует старый asset через библиотеку Expo.

В Room сохраняется `content://` URI MediaStore. Нажатие на уведомление открывает этот URI через `Intent.ACTION_VIEW` с MIME-типом и `FLAG_GRANT_READ_URI_PERMISSION`.

## 10. Уведомления

Нужно создать три канала:

| Канал | Назначение | Звук |
|---|---|---|
| `agnes_progress` | постоянное уведомление foreground Worker | тихий |
| `agnes_completed` | готовый результат | звук и вибрация |
| `agnes_errors` | окончательная ошибка | звук по настройке |

На Android 13+ приложение должно корректно обработать runtime permission `POST_NOTIFICATIONS`. Уведомление foreground service всё равно должно быть создано для работы Worker, но видимость обычных уведомлений зависит от разрешения пользователя. [5]

Уведомление о готовности содержит `taskId`, `contentUri`, MIME-тип и PendingIntent. Нажатие открывает готовое фото или видео напрямую.

## 11. Миграция Expo-прототипа

Миграцию рекомендуется делать поэтапно, а не переписывать приложение целиком.

| Этап | Результат |
|---|---|
| 1 | Создать Android Studio проект и собрать пустое приложение на JDK 21 |
| 2 | Перенести типы задач, профили, настройки и payload builders |
| 3 | Подключить Room и миграцию локальных данных |
| 4 | Подключить Keystore для Agnes и ImgBB ключей |
| 5 | Реализовать Retrofit API и чистые unit-тесты |
| 6 | Реализовать один Worker для text2img |
| 7 | Добавить polling, progress и retry |
| 8 | Добавить видео text/reference/keyframe |
| 9 | Подключить MediaStore |
| 10 | Подключить уведомления и открытие результата |
| 11 | Реализовать два слота на профиль |
| 12 | Перенести UI задач, профилей и настроек |
| 13 | Провести тесты закрытия, перезапуска и reboot |
| 14 | Выпустить signed APK и отдельно AAB для Google Play |

На первом переходном этапе можно оставить текущий Expo UI и вызвать нативный Kotlin-модуль через Expo Module API. Для надёжного WorkManager и MediaStore итоговый APK всё равно должен собираться как custom development/release build, а не через обычный Expo Go.

## 12. Тест-план

### Функциональные тесты

Проверить text2img, img2img, multi_ref, face_swap, text-to-video, reference и keyframe. Проверить каждую модель и допустимые значения длительности.

### Тесты очереди

Проверить две задачи на одном профиле, две задачи на разных профилях, фото и видео одновременно, повторное нажатие, отмену queued-задачи и автоматическое продолжение.

### Тесты жизненного цикла

Закрыть экран приложения во время polling. Убрать приложение из recent apps. Перезагрузить телефон. Отключить сеть и восстановить её. Проверить, что Worker продолжает или безопасно повторяет задачу.

### Тесты разрешений

Проверить Android 10, 12, 13, 14 и 15. Проверить полный доступ к уведомлениям, запрет уведомлений, отсутствие отдельного запроса на изменение каждого результата и появление файлов в правильных папках.

### Тесты ограничений

Проверить 429, временный 5xx, недоступный ImgBB, неправильный API-ключ, истёкший server task id и превышение пользовательского polling limit.

## 13. Критерии готовности

Нативная версия считается готовой, если активная генерация продолжается после сворачивания приложения, queued-задача запускается без открытия UI, после перезагрузки телефона состояние восстанавливается, результат появляется в `Pictures/Agnes-AI` или `Movies/Agnes-AI`, уведомление открывает именно этот файл, а text2img не отображает видео assets и кадровые настройки.

Отдельным условием является корректная обработка Android 15 timeout для `dataSync`. Worker или сервис должен уметь остановиться контролируемо и записать понятную ошибку вместо аварийного завершения процесса. [4]

## 14. Практический следующий шаг

Начинать следует с минимального вертикального среза: один профиль, одна text2img-задача, один `CoroutineWorker`, foreground notification, Room, MediaStore и открытие результата из уведомления. После успешного теста закрытия приложения добавляются видео, несколько профилей и остальные режимы. Такой порядок уменьшает риск одновременно отлаживать сеть, очередь, разрешения и сложный UI.

## References

[1]: https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running "Support for long-running workers"
[2]: https://developer.android.com/training/data-storage/shared/media "Access media files from shared storage"
[3]: https://developer.android.com/about/versions/14/changes/fgs-types-required "Foreground service types are required"
[4]: https://developer.android.com/develop/background-work/services/fgs/timeout "Foreground service timeouts"
[5]: https://developer.android.com/develop/ui/compose/notifications/notification-permission "Notification runtime permission"
