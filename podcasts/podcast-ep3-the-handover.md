# Podcast Script — Episode 3: "The Handover"

> Same two voices. **HOST** is the incoming maintainer with the repo open in front of them.
> **DEV** is handing the project off and walks the actual code — real class names, real
> methods, real fields, in the order the code runs. This is not theory; it's a guided tour you
> can follow with the files open. Where a line is load-bearing or cursed, we stop and say why.
> Est. run time: ~55–65 min. Pause it. Open the file being discussed. That's the point.
>
> Episodes 1 and 2 covered *what* and *the techniques*. This one is *our code, specifically*.
> When DEV names a class, it exists; when DEV names a field, grep it.

---

## COLD OPEN — what owns what

**HOST:** I've got the repo open. One package, `net.runelite.client.plugins.gpuvulkan`, eighty-odd files, plus one Objective-C file under `src/main/native`. Where's the center of gravity?

**DEV:** `GpuVulkanPlugin.java`. That's the spine. Read its class declaration and you already know the shape of the whole thing: `class GpuVulkanPlugin extends Plugin implements DrawCallbacks, VulkanRenderBackend`. Three hats. It's a RuneLite `Plugin` so it has `startUp` and `shutDown`. It's a `DrawCallbacks` so the game engine calls *it* every time it wants to draw the world. And it's a `VulkanRenderBackend` so other plugins can register render extensions against it.

**HOST:** So the engine talks to this one class, and this class fans work out to everything else.

**DEV:** Right. Hold four field names in your head from the top of that file and the rest decodes. `renderer` — a `VulkanRenderer`, owns the per-frame submit/present. `renderExtensions` — a `RenderExtensions`, the list of things that actually draw. `disposables` — a `Disposables`, which is a LIFO close-stack; everything we create gets pushed onto it and torn down in reverse. And two `static volatile` fields, `activeInstance` and `shuttingDown`, which exist purely because of the JVM shutdown hook. We'll get to why those are static.

**HOST:** Start me at `startUp`.

---

## SEGMENT 1 — startUp, and why the construction order is sacred

**DEV:** `startUp` does almost nothing synchronously. It checks `isStockGpuEnabled()` first — if RuneLite's stock OpenGL "GPU" plugin is on, we refuse to start and log a warning, because two owners of the rlawt context corrupt JAWT state and crash the JVM. Then it registers the shutdown hook once, sets `startRequested = true`, and the real work happens inside `clientThread.invoke(...)`.

**HOST:** Why defer onto the client thread?

**DEV:** Because all the engine and AWT state we touch has to be touched from the client thread, and because we *defer until we're actually logged in*. Look at the top of that lambda: if `client.getTextureProvider()` is null, or `client.getGameState() != GameState.LOGGED_IN`, we return `false` — which tells `clientThread.invoke` to retry next tick. Attaching on the login screen leaves a blank canvas that's indistinguishable from a broken surface, especially on macOS. So we wait.

**HOST:** Then the actual setup.

**DEV:** Then a very specific construction order, and the order is not arbitrary — it's encoded in the `Disposables` stack. Watch it: we grab `canvas = client.getCanvas()`. On everything except macOS we create an `rlawt.AWTContext` and a GL context we never render with — that's a workaround, AWT's X11 resize path on Linux expects a live GLX context on the canvas thread or the EDT `exit_group`s mid-rebuild when you collapse the sidebar. On macOS we skip that because we attach our own Metal layer.

**HOST:** Then Vulkan objects.

**DEV:** In order: `new VulkanInstance`, `new VulkanSurface`, `new VulkanDevice`. Then — and read the comment here, it's a LANDMINE tag — `new FrameSync` is registered on the disposables stack **before** `new Swapchain`. Disposables is LIFO. So at teardown the swapchain destroys *first*, releasing the windowing system's references to the `renderFinished` semaphores, and only *then* do the semaphores get destroyed. Do it the other way and AMD's RADV driver hangs in `vkDestroySemaphore` waiting for a present that owns the semaphore. `vkDeviceWaitIdle` does not drain the presentation engine. That ordering bug cost real days; the fix is "register FrameSync first."

**HOST:** Keep going.

**DEV:** Then MSAA sample count from `config.antiAliasingMode()` run through `device.pickSampleCount`. Note the macOS carve-out: if `device.supportsMetalObjects()` and samples aren't 1, we force samples back to 1 — MSAA on the macOS custom-present path is currently disabled while a MoltenVK submit crash is isolated. Then `DepthBuffer`, optionally `MsaaColorBuffer`, `RenderPass`, `Gfx.wrap` to get the `gfx` renderer, `TextureArray`, a `RegionManager`, then `RenderExtensions` — and we immediately `register(new BaseRenderer())`. Then `Framebuffers`, then `VulkanRenderer`, and we hand it the `DrawManager` for screenshots.

**HOST:** And the very last steps?

**DEV:** Order matters again. We set `activeInstance = this` *after* full init, so the shutdown hook can never observe a half-built plugin. Then `client.setDrawCallbacks(this)` — that's the switch that makes the engine start calling us. Then `applyClientRuntimeConfig()` and `client.resizeCanvas()` to get an alpha channel on the canvas. And finally, if a scene is already loaded — because the user enabled us mid-session — we call `captureSceneNow` right away instead of waiting for a chunk crossing.

**HOST:** There's a giant `catch (RuntimeException e)` around all of it.

**DEV:** And it matters. A mid-startup throw — device pick fails, swapchain fails — has to undo everything in the same order `shutDown` would: drain the device, restore client runtime config, `setDrawCallbacks(null)`, close disposables, destroy the AWT context, un-set `ignoreRepaint`, detach the Metal layer on mac. Without that unwind, the canvas is left with `ignoreRepaint=true` and a half-attached context, and the next time you toggle the plugin JAWT's lock fails — which presents to the user as "the plugin won't turn back on." So the recovery path is a mirror of teardown. Respect it.

---

## SEGMENT 2 — the DrawCallbacks contract: how the engine feeds us

**HOST:** Okay, draw callbacks are set. Now the engine is driving. Which methods fire, and in what order?

**DEV:** This is the part you most need internalized, because the engine's calling pattern in this client version is *not* what the interface docs imply. Let me give you the live ones.

**HOST:** Start with the camera and scene.

**DEV:** `preSceneDraw` fires first each frame. It hands us camera floats — `cameraX/Y/Z`, pitch, yaw — and the level range `minLevel, level, maxLevel`, and a `Set<Integer> hideRoofIds`. Three critical things happen here. One: we stash those camera floats into `lastCamX` etc., and *these* are the ones we build the projection matrix from — not the doubles from `drawScene`, which are a different reference frame. Two: scene-transition detection. We compare `scene != capturedScene` by reference. The engine's `swapScene` and `loadScene` callbacks *do not fire* in this version — reconnaissance showed swap=0, load=0 — so the only reliable signal that the world changed is the `Scene` object identity changing. On a change we call `captureSceneNow`. Three: `scene.setDrawDistance(config.drawDistance())` — that drives the engine's own clickbox loops; without it only tiles within the engine's tiny default range register mouse clicks. And we forward `hideRoofIds` to the extensions.

**HOST:** Then `drawScene`?

**DEV:** `drawScene` is where per-frame capture kicks off. It calls, in order: `renderExtensions.beginFrame()`, then `rebuildDirtyZones(capturedScene)`, then `captureDynamicPending()`. That's: reset the frame's write cursor, rebuild any zones marked dirty, and retry any renderables whose models weren't streamed yet. Note it does *not* use the camera doubles it's passed — comment says so explicitly.

**HOST:** And individual models?

**DEV:** Three entry points, all funnel into `renderExtensions.captureModel(...)`. `drawDynamic` for actors and dynamic objects — it computes `actorModel = r instanceof Actor || tileObject == null` and passes the projection. `drawTemp` for temporary game objects like spawned objects. And `draw(Projection, Scene, Renderable, ...)` — the single-renderable path.

**HOST:** I see a big comment on that last `draw` method. "Don't delete the rest of this method."

**DEV:** Read it out loud, because it's the most honest comment in the codebase. Projectiles, spell animations, and the home-teleport graphic stop rendering without that method body — *even though the stats counter at the top says the method never runs*. We don't fully understand why yet; it's issue #1. So: it looks dead, the counter says it's dead, and deleting it breaks projectiles. Leave it. That's the kind of thing this engine does to you.

**HOST:** And the method actually named `draw`, the one taking just `overlayColor`?

**DEV:** That's the frame trigger — the heartbeat. Everything above is the engine *describing* the scene to us. `draw(int overlayColor)` is the engine saying "now paint it." It validates the canvas, handles resize (different paths for swapchain vs custom-present — `updateCustomPresentGeometry` on mac, `markSwapchainStale` elsewhere), grabs `client.getBufferProvider()` for the UI pixels, and calls `renderer.drawFrame(...)` with the whole pile of state: canvas size, UI pixels, the stashed camera, viewport offsets, skybox color, brightness from `client.getTextureProvider().getBrightness()`, the config-driven knobs, and the game tick masked with `& 127` to stop float drift in texture animation. That one call is the entire frame. We'll follow it in segment 6.

---

## SEGMENT 3 — the extension fan-out

**HOST:** You keep saying `renderExtensions`. What's actually in that list?

**DEV:** `RenderExtensions` is a `List<VulkanRenderExtension>` with crash isolation. Every callback — `beginFrame`, `captureModel`, `recordRenderPass`, all of them — is fanned out to each registered extension inside a try/catch. Look at `forEachExtension`: if an extension throws, it's *removed from the list and closed*, and the rest keep running. One misbehaving extension can't take down the renderer. That's deliberate, because this is meant to be a reusable backend other plugins build on.

**HOST:** What's registered by default?

**DEV:** One thing: `BaseRenderer`. And `BaseRenderer` is a thin dispatcher. It holds the real workers — a scene renderer and an interface renderer — and forwards each `VulkanRenderExtension` method to them, gated by config flags like `benchmarkSkipScene`, `benchmarkSkipUi`, `benchmarkSkipDynamicCapture`. So the benchmark toggles literally short-circuit the dispatch.

**HOST:** And below BaseRenderer?

**DEV:** A small adapter chain. `BaseRenderer` talks to the `VulkanSceneRenderer` interface; the concrete implementation is `DefaultVulkanSceneRenderer`, which is a near-pure pass-through to the real workhorse class, `SceneRenderer`. The one bit of logic in that adapter worth knowing: the `captureModel` overloads that carry a `Projection` get routed to `captureModelSorted`, while the bare `captureModel(Model, …)` goes to the unsorted path. That routing decision is how a model ends up sorted or not.

**HOST:** And third-party extensions?

**DEV:** `VulkanExtensionQueue`. A plugin can call `registerExtension` before our backend is even live — the queue holds the registration and `attachQueued` wires them all in once `renderExtensions` exists. On teardown `markBackendDetached` flips them so closing a registration cleans up correctly whether or not the backend is still up. It's lifecycle plumbing so external code doesn't have to know our startup timing.

---

## SEGMENT 4 — SceneRenderer, part one: the buffer and the static capture

**HOST:** `SceneRenderer.java` is the biggest file. Give me its skeleton before we walk methods.

**DEV:** It's the heart. It implements three sink interfaces at once — `PendingRenderables.Sink`, `SceneModelEmitter.VertexSink`, `SceneTileEmitter.Sink` — because it owns the vertex memory everyone writes into. Memorize the constants at the top: `MAX_STATIC_VERTICES = 5_000_000`, `MAX_FRAME_VERTICES = 3_000_000`, and `TOTAL_BUFFER_BYTES = STATIC + FRAME * FRAMES_IN_FLIGHT`. That's one host-visible buffer: a five-million-vertex static arena at the front, then three three-million-vertex frame arenas behind it. Each vertex is `ScenePipeline.VERTEX_STRIDE` — 20 bytes.

**HOST:** That's the "static once, dynamic times three" idea from episode two, made concrete.

**DEV:** Exactly that idea, here's where it lives. The write cursor is three fields — `writePtr`, `writeBasePtr`, `writeBaseVertex` — and two methods flip between arenas: `useStaticWriteArena()` points the cursor at the front of the mapped buffer; `useFrameWriteArena(slot, logicalVertex)` points it past the static region at `STATIC_BUFFER_BYTES + slot * slotBytes`. Everything that writes geometry ultimately calls `SceneVertexPacker.writePacked` at `writePtr` and advances by 20.

**HOST:** And the world is a grid. How's that indexed?

**DEV:** `ZONE_SIZE = 8` tiles, `ZONES_PER_SIDE = SCENE_SIZE / 8 = 13`, so `ZONE_COUNT = 169`. The bookkeeping arrays are the thing to stare at: `zoneVertexStart[layer][plane][zone]` and `zoneVertexCount[...]` record exactly which slice of the static arena holds each zone's geometry on each plane. `planeEnds[layer][plane]` records the cumulative vertex count after each plane. And there's a parallel set prefixed `overlay` — `overlayZoneStart`, `overlayZoneCount`, `overlayZoneValid` — indexed *also* by frame slot, for dirty re-captures. That's a lot of arrays, but they're the entire culling and roof-hiding mechanism, so they earn their keep.

**HOST:** Walk `captureScene`.

**DEV:** `captureScene` runs on a region change — rare, expensive, so the first line is `vkDeviceWaitIdle`: drain the whole GPU before we rewrite the shared buffer. Then it zeroes all the bookkeeping, calls `useStaticWriteArena()`, and emits the five static layers in a fixed order via `captureLayer`: TERRAIN, WALLS, DECORATIVE, GROUND, GAME_OBJECTS. The sixth layer in the `Layer` enum, DYNAMIC, is never static — it's per-frame.

**HOST:** Why that specific layer order?

**DEV:** Because we emit layer-major, plane-minor, and `recordDraw` later relies on it: vertices for a whole layer are contiguous, and within a layer, sorted by plane. That lets roof-hiding clip per plane instead of as a flat world-space cut. Inside `captureLayer`, for each output level and each zone, we walk the tiles and call a `TileCapture` lambda — for TERRAIN that pulls `getSceneTilePaint` and `getSceneTileModel`; for WALLS the wall object's two renderables; for DECORATIVE the decorative object's two renderables with their offsets; for GROUND the ground object; and GAME_OBJECTS has its own pass because multi-tile objects must emit only on their `getSceneMinLocation` tile to dedupe.

**HOST:** And the `visbelow` thing in `captureLayerPass`?

**DEV:** That's the roof / multi-level subtlety. `SceneRoofInfo.forTile(roofs, tileSettings, sourceLevel, msx, msy)` returns two things: a `visbelow` flag and a `roofId`. Level 0 contains its own geometry *plus* the "visible below" geometry from upper levels; upper levels contain only their non-visbelow source level. This mirrors stock's SceneUploader so roof removal doesn't behave like a flat clipping plane. And when `roofInfo.roofId != 0` and we actually emitted vertices, we call `recordRoofRange(roofId, before, count)` — that's how we remember "these exact vertices belong to this roof," which `recordDraw` uses later to skip them.

**HOST:** One offset I see everywhere: `roofOffset`.

**DEV:** `Scene.getRoofs()` is dimensioned `EXTENDED_SCENE_SIZE` — 184 — on the top-level world view, but `getTiles()` is `SCENE_SIZE`, 104. So roof lookups need `(EXTENDED - SCENE)/2` added on top-level, zero on instances. Get that offset wrong and roofs hide the wrong tiles. It's threaded through every capture method as a parameter so it's impossible to forget.

---

## SEGMENT 5 — SceneRenderer, part two: models, tiles, dirty zones, the dynamic suffix

**HOST:** Tiles I follow. How does a *model* — an NPC, a tree — become vertices?

**DEV:** Through `SceneModelEmitter`. The interesting method is `captureModelSorted`, and its whole job is to *decide which path a model takes*, because sorting is expensive and most models don't need it. First it consults `ModelFaceCache` — an identity-hash cache keyed on the model's face count and the identity of its `faceTransparencies` array — to get a cached count of transparent faces without re-scanning. Then it branches: if the render mode is `RENDERMODE_SORTED_NO_DEPTH`, force a full sort. If the model is opaque and under the `OPAQUE_UNSORTED_FACE_THRESHOLD` — 64 faces by default — go straight to the unsorted path. If it has transparent faces, try the cull-only fused path. Otherwise fall back to the full `ModelSorter`.

**HOST:** And `ModelSorter` is the bucket sort from episode two.

**DEV:** The exact one — ported from stock's `FacePrioritySorter`, copyright preserved. It projects every vertex, near-plane-rejects anything closer than z=50 (drops the whole model, same as stock), back-face-culls via the screen-space cross product, buckets surviving faces by depth using the stamp-invalidation trick, and writes `sortedFaces[]` in back-to-front order. `captureModelSorted` then walks those sorted faces and, per face, computes UVs through `ModelUvMapper.computeFaceUvs` and calls back into `SceneRenderer`'s `VertexSink` methods — `writeRotatedVertexRgb`, `writePackedTriangleRgbNoUv`, and friends — which do the rotate-by-orientation and write 20-byte vertices at the cursor.

**HOST:** Where do "priority" faces get recorded?

**DEV:** `PriorityRangeSet`. When a model is drawn in the priority mode, `SceneModelEmitter` records the start and end vertex of its range, and mirrors that into a skip-pairs array. `recordDraw` later draws those ranges through two dedicated pipelines — color then depth — to reproduce the engine's priority layering. We'll see that in segment 7.

**HOST:** And `SceneTileEmitter`?

**DEV:** Simpler. `captureTilePaint` reads the four corner HSL colors and the tile's heights from `scene.getTileHeights()`, builds a 128-unit quad in world space, and emits two triangles, six `writeHslVert` calls, with the texture layer as `paint.getTexture() + 1` — remember layer 0 is the white reserve. `captureTileModel` reads the tile model's faces and per-triangle colors and emits per triangle with UVs normalized into the tile's 0–1 range. Both write HSL directly; the shader does HSL→RGB.

**HOST:** Now the per-frame stuff. `beginFrame`, dirty zones, the dynamic suffix.

**DEV:** `beginFrame` is where the frame's safety wait lives — and read the comment, it ties straight to the flicker bug. It does `vkWaitForFences` on this slot's in-flight fence *before* touching the slot's arena, because if the CPU starts writing this slot's vertices while the GPU is still reading them from three frames ago, you get torn-vertex flicker — worse on macOS where Metal holds frames longer. Then it resets `vertexCount` to `overlayNextVertex[slot]` and points the cursor at the frame arena via `useFrameWriteArena`.

**HOST:** What's `overlayNextVertex`?

**DEV:** The boundary between the dirty-zone overlay geometry and the dynamic geometry, per slot. Dirty static zones get re-captured into the front of the frame arena; the truly dynamic stuff — actors, projectiles — piles on after. `rebuildDirtyZones` handles the first part: it consults `DirtyZoneTracker`, which is the clever bit. A zone gets marked dirty once, but it has to be rebuilt in *all three* frame slots before it's clean, because each slot is a separate copy. So `DirtyZoneTracker` keeps a per-zone bitmask of which slots have been rebuilt; `needsSlot(zone, slotBit)` returns true until this slot's bit is set, and `markSlotRebuilt` ORs the bit in and only drops the zone from the dirty count once all-slots are done.

**HOST:** And models whose data hasn't streamed in yet?

**DEV:** `PendingRenderables`. When `captureRenderable` resolves a model and gets null — not loaded yet — it parks the renderable with its zone in `pendingRenderables`. Each frame `captureDynamicPending` calls `captureLoaded`, which retries resolution; anything that's loaded since gets emitted and its zone marked dirty so it promotes through the overlay path, and anything still null rolls forward. It's a retry queue for asynchronous model loading.

**HOST:** And `drawPass`?

**DEV:** The engine calls `drawPass(PASS_OPAQUE)` to delimit opaque versus alpha dynamic geometry. We record `dynamicOpaqueEnd = vertexCount` at that boundary, so `recordDraw` can draw the opaque dynamic range in the main pass and the rest in the alpha pass.

---

## SEGMENT 6 — VulkanRenderer.drawFrame: the frame, start to finish

**HOST:** Okay. Back up to `renderer.drawFrame(...)` — the heartbeat call. Walk it.

**DEV:** `VulkanRenderer.drawFrame`. First it stashes all that incoming state — camera, viewport, brightness, fog, tick — into fields, because the matrix gets built later at record time. Then, inside a `MemoryStack` push, the first real action is a fence wait, and this is *the* comment to read in the whole file.

**HOST:** The one about the UI layer.

**DEV:** Verbatim intent: wait on this slot's in-flight fence *before* writing the UI staging buffer, because the CPU memcpy in `uploadUiPixels` can race the GPU's copy from three frames ago, producing a half-old half-new UI texture that reads as "the UI layer intermittently covering and uncovering." That's a described symptom of the layer-flicker family. So: wait, then `renderExtensions.uploadUiPixels(...)` to memcpy the AWT pixels into the persistently-mapped staging buffer. Then it branches: `drawFrameCustomPresent` on macOS, `drawFrameSwapchain` everywhere else. Then `sync.advance()`.

**HOST:** Do the swapchain path first.

**DEV:** `drawFrameSwapchain`: `vkAcquireNextImageKHR` with the `imageAvailable` semaphore to get an image index. If it returns `OUT_OF_DATE` or `SUBOPTIMAL`, mark the swapchain stale and bail or flag rebuild. Reset this frame's fence. Grab the per-frame command buffer, reset it, and call `recordClearPass` — which records the entire frame's commands. Then `submit` with the semaphores, `processDrawComplete` for screenshots, and `present`. The `submit` method waits on `imageAvailable` at the `COLOR_ATTACHMENT_OUTPUT` stage, signals `renderFinishedFor(imageIdx)` — note, per *image*, not per frame — and trips the in-flight fence. `present` waits on that per-image semaphore.

**HOST:** And `recordClearPass` is the meat.

**DEV:** It is. `vkBeginCommandBuffer`. Then `renderExtensions.recordBeforeRenderPass(cmd)` — that's where UI texture uploads and layout transitions happen, *outside* the render pass, because `vkCmdCopyBufferToImage` is illegal inside one. Then two clear values: the color cleared to the skybox color from `client.getSkyboxColor()` so the area beyond geometry blends into the sky, and — episode two callback — the depth cleared to `0.0`, because the projection is reverse-Z and closer means bigger. `vkCmdBeginRenderPass`.

**HOST:** Then the viewport math, which I remember has a landmine.

**DEV:** Two, actually. First: the scene viewport is the OSRS viewport rect — the area inside the canvas where the UI is transparent — but the DPI stretch ratio is derived from *canvas* dimensions, not viewport dimensions. The comment is long because the bug was nasty: deriving DPI from viewport dims gives different X and Y ratios whenever the viewport is shorter than the canvas, e.g. resizable mode's toolbar, and that non-uniform stretch shifts rendered tiles tens of pixels off the engine's projection target — which shows up as "clicks only work in shifting spots near the player." So `dpiX = targetWidth / canvasWidth`, `dpiY = targetHeight / canvasHeight`. Canvas, not viewport.

**HOST:** And the second?

**DEV:** The Y-flip. We build the scene matrix in `Mat4Ops` as `scale(scale, -scale, 1)` times projection times rotateX(pitch) times rotateY(yaw) times translate(-camera). The Y is negated *in the matrix* to map the projection's OpenGL y-up clip space into Vulkan's y-down clip space. The comment notes they tried the `KHR_maintenance1` negative-height viewport instead and the runtime silently ignored it, leaving everything rendered on the wrong half. So the flip lives in the matrix. Then it packs all that into a `DefaultVulkanFrameContext` and calls `renderExtensions.recordRenderPass(frame)` — that's the fan-out where `SceneRenderer.recordDraw` and the UI both record their commands. After the scene, it switches the viewport back to the full canvas for the UI quad, ends the render pass, and records the screenshot readback copy.

**HOST:** Now the macOS path.

**DEV:** `drawFrameCustomPresent` is the divergence we covered conceptually in episodes one and two — here's the real code. Instead of `vkAcquireNextImageKHR`, it calls `MacOSMetalHelper.nextDrawable()`, which returns a `long[]`: drawable pointer, `MTLTexture` pointer, width, height. If it's null — the layer timed out — we resize and retry once, then treat it as a dropped frame. If the drawable size changed, we `vkDeviceWaitIdle`, flush the `MetalDrawableSet` cache, and recreate depth and MSAA. Then `metalDrawables.acquire(mtlTexture, width, height, ...)` — that imports the `MTLTexture` as a `VkImage` via `VkImportMetalTextureInfoEXT` and caches the wrapper keyed on the texture pointer, so we build it once and reuse. We record the same clear pass into that framebuffer, then `submitNoSemaphores` — no wait semaphore, no signal semaphore, because we present on the same Metal queue and Metal's in-queue ordering does the sequencing for free. We wait the fence, then `MacOSMetalHelper.presentDrawable(drawable, device.metalCommandQueue())`. That queue pointer was extracted once at device creation via `vkExportMetalObjectsEXT`.

---

## SEGMENT 7 — SceneRenderer.recordDraw: how draws actually get issued

**HOST:** You've twice now said "recordRenderPass fans out and `SceneRenderer.recordDraw` records its commands." That method is dense. Walk it.

**DEV:** It's the busiest method in the project and it's worth ten minutes. First, if `vertexCount == 0`, bail — nothing captured. Then a LANDMINE: we bind the vertex buffer at byte offset *zero* and address the per-slot arena via `firstVertex` in the draw calls, not via a byte offset on the bind. MoltenVK's offset translation produces no visible geometry at hundreds-of-megabytes offsets on Apple Silicon. So `slotFirstVertex = MAX_STATIC_VERTICES + slot * MAX_FRAME_VERTICES - staticVertexCount()` is computed and added to every dynamic draw's first-vertex, and static draws use `staticFirstVertex = 0`.

**HOST:** Then the push constants.

**DEV:** Two buffers built on the stack. The vertex push is 96 bytes: the mat4 MVP via `Mat4Ops.writeTo`, then at offset 64 a vec4 of `(cameraX, cameraZ, drawDistance*128, fogDepth*128)`, then an ivec4 with the tick. The fragment push is 32 bytes at offset 96: a vec4 `(fogR, fogG, fogB, brightness)` and a vec4 `(textureLightMode, colorBlindMode, colorBlindIntensity, smoothBanding)`. And here's the two-values-in-one-float trick from episode two, in the flesh — the last lane is `singlePassAlpha ? 20 + smoothBanding : smoothBanding`, and a separate `alphaFragPush` uses `10 + smoothBanding`. The fragment shader integer-divides by ten to recover which alpha pass it's in.

**HOST:** Then it builds skip pairs.

**DEV:** `roofRanges.buildSkipPairs(hideRoofIds, skipScratch)` — for every recorded roof range whose ID is in the engine's current `hideRoofIds`, it writes a `[start, end)` skip pair. Those are the vertex sub-ranges we will *not* draw this frame. Then it computes the visible-zone window: `radiusZones` from draw distance plus fog depth, the camera's zone from `cameraX/Z`, and a min/max zone box. If the radius covers the whole scene, `fullZoneRange` is true and culling is skipped.

**HOST:** And then the actual draws.

**DEV:** A loop over the six layers. For each, it picks a pipeline — the line pipeline if that layer's `wireframe` flag is set and the device supports non-solid fill, otherwise `fillPipeline` — and binds pipeline plus the descriptor set (the texture array and animation UBO). For the DYNAMIC layer, it draws the dynamic range from `overlayNextVertex[slot]` to `dynamicOpaqueEnd`, honoring the priority skip-pairs. For static layers, it draws one plane at a time from `minPlane` to `maxPlane`, calling `zoneDrawScheduler.drawStaticPlane` and `drawOverlayPlane` — and crucially it only applies the roof skip-pairs for planes *above* the current plane, so a building you're standing in doesn't get its lower walls chopped when its roof ID is hidden.

**HOST:** What does the zone scheduler actually do with all that?

**DEV:** `SceneZoneDrawScheduler` turns zone ranges plus skip-pairs into `vkCmdDraw` calls. `drawStaticPlane`, when culling, walks only the visible zones and coalesces contiguous `zoneVertexStart/Count` ranges; when `fullZoneRange`, it draws the whole plane but builds skip-pairs for any zones that have a live overlay copy — because if a zone was re-captured into the overlay arena, the stale static copy must be skipped — and merges those with the roof skip-pairs via `mergeSkipPairs`. `drawOverlayPlane` draws the overlay copies for dirty zones. Both ultimately call `SceneDrawEmitter.drawRange`, which is where a single logical range becomes *multiple* draw calls that step over the skip sub-ranges.

**HOST:** That's the roof-hiding-as-gaps idea from episode one.

**DEV:** Right — `SceneDrawEmitter.drawRange` walks the sorted skip-pairs and issues a `vkCmdDraw` for each gap between them. Want to skip vertices 100–150? You draw 0–100, then 150 onward. No separate roof geometry, just gaps in the draw list.

**HOST:** And there are extra passes after the layer loop.

**DEV:** Two. If `priorityRanges.count() > 0`, we bind `priorityColorPipeline` and draw the priority ranges, then bind `priorityDepthPipeline` and draw them again — color write then depth write, separated, to reproduce the engine's priority-face layering. And if we're *not* in single-pass alpha mode, we bind `alphaPipeline` and run `drawAlphaPass`, which replays the layers with the `alphaFragPush` so transparent faces blend in a dedicated pass. With single-pass alpha on — the default — that second pass is skipped and alpha-to-coverage in the MSAA handles transparency in the main pass.

**HOST:** One field I keep seeing: `repushConstantsEveryDraw`.

**DEV:** It's `device.supportsMetalObjects()` — true on macOS. On Mac, MoltenVK has push-constant reuse quirks, so we re-push the constants on *every* draw rather than once per pipeline bind. On Linux we push once per pipeline. It's a per-platform correctness flag threaded through `SceneDrawEmitter`.

---

## SEGMENT 8 — the Gfx layer and the UI, concretely

**HOST:** The scene draws raw Vulkan. But you mentioned a `gfx` abstraction. Where's that actually used?

**DEV:** The scene path uses raw Vulkan and the `ScenePipeline` directly — it predates the abstraction and it's hot, so it stays explicit. The `gfx` package is used by the UI and by FSR. `Gfx.wrap(device, sync, renderPass)` returns a `GfxRenderer` that implements the `Renderer` interface over our existing objects without owning them — its `close()` only frees what it created.

**HOST:** And the UI is an extension?

**DEV:** `InterfaceRenderer`, yes. It owns a `GfxStreamingImage` — a ring of `FRAMES_IN_FLIGHT` textures plus staging buffers — and a `GfxBindGroup`. When `uploadUiPixels` is called, it `memcpy`s the AWT pixels into the current slot's staging buffer; there's an optional dirty-row path behind `vkgpu.uiDirtyRows` that only re-uploads changed scanlines using `Arrays.mismatch`. Then `recordBeforeRenderPass` does the `vkCmdCopyBufferToImage` and the layout transitions, outside the render pass. Then in the render pass, `recordDraw` binds the UI pipeline and bind group and issues a three-vertex draw — a fullscreen triangle, no vertex buffer, `gl_VertexIndex` generates the corners in `ui.vert`. `ui.frag` samples the UI texture and mixes in `overlayColor` as a tint with its alpha as the blend factor — that's the login fade and hit-splat flash.

**HOST:** And the `GfxBindGroup` per-slot thing?

**DEV:** Same correctness idea as the vertex arenas. A single logical `GfxBindGroup` allocates `FRAMES_IN_FLIGHT` descriptor sets, and `descriptorSetForCurrentFrame()` hands back the one whose descriptor points at the current slot's texture in the streaming ring. So when the encoder binds "the bind group," the GPU samples the right slot's UI texture and never the one the CPU is writing. The triple-buffering is real but the caller never sees it.

---

## SEGMENT 9 — the platform floor: instance, device, surfaces, native

**HOST:** Below all of this is the Vulkan setup and the platform glue. Give me the load-bearing facts per class.

**DEV:** `VulkanInstance`: enumerates available extensions and filters the requested ones against them — important because on macOS `VK_KHR_portability_enumeration` may not be advertised when MoltenVK is bundled. If validation is on and `VK_LAYER_KHRONOS_validation` is present, it wires a debug messenger that routes to slf4j and opts into synchronization validation. And if portability enumeration made the list, it sets the `ENUMERATE_PORTABILITY` instance flag — without it, `vkCreateInstance` returns `ERROR_INCOMPATIBLE_DRIVER` on Mac.

**HOST:** `VulkanDevice`.

**DEV:** Picks the first physical device with a single queue family that supports both graphics and present. Reads features into `supportsFillModeNonSolid` (gates wireframe), `supportsSamplerAnisotropy`, and computes `maxSampleCount` by ANDing the color and depth sample masks. Enables `VK_KHR_swapchain` always, `VK_KHR_portability_subset` if advertised — mandatory on MoltenVK or device creation fails — and `VK_EXT_metal_objects` if present and custom-present isn't disabled. When metal objects are on, `extractMetalCommandQueue()` calls `vkExportMetalObjectsEXT` to pull the `id<MTLCommandQueue>` MoltenVK created, and stashes it in `metalCommandQueue` — that's the queue we present on. `supportsMetalObjects()` being true is the single flag that flips the whole renderer onto the macOS custom-present path.

**HOST:** Surfaces.

**DEV:** `PlatformSurface.current(vsync)` sniffs `os.name` and returns one of three. `X11PlatformSurface` pulls the X11 display and drawable out of JAWT and calls `vkCreateXlibSurfaceKHR`; it also exposes `currentDrawable` so the plugin can detect when X11 swaps the drawable under us and recreate the surface — that's `ensureNativeSurfaceCurrent` in the plugin. `Win32PlatformSurface` pulls the HWND and module handle and calls `vkCreateWin32SurfaceKHR` — implemented, never tested, that's issue #4 if you have a Windows box. `MacOSPlatformSurface` calls `MacOSMetalHelper.attachMetalLayer`, then writes the layer pointer into the create-info manually with `memPutAddress` because LWJGL 3.3.6's `pLayer` binding has a bug, then `vkCreateMetalSurfaceEXT`.

**HOST:** And the native file.

**DEV:** `rlmtl.m`, compiled to `librlmtl.dylib`, extracted from the classpath and `System.load`ed by `MacOSMetalHelper`. `nAttachMetalLayer` initializes JAWT, grabs the `JAWT_SurfaceLayers` bridge, and on the main thread creates a `CAMetalLayer` — pixel format BGRA8Unorm, `displaySyncEnabled = NO` for now, `drawableSize` 1×1 initially to avoid colliding with MoltenVK's internal swapchain — and assigns it into AWT's hierarchy. It also spins up a `CADisplayLink` whose tick syncs `drawableSize` to the bounds and `[CATransaction flush]`es so async presents reach the compositor. `nNextDrawable` and `nPresentDrawable` are both wrapped in `@autoreleasepool` — mandatory, because JNI threads have no top-level pool and autoreleased Metal objects would pile up and crash MoltenVK around fifty frames in. `nRetainObject`/`nReleaseObject` pin `MTLTexture` handles while we cache their `VkImage` wrappers.

**HOST:** And `ClientRuntimeConfig`?

**DEV:** It applies the engine-side settings on enable and restores them on disable: GPU flags (`GPU | ZBUF`, plus `NO_VERTEX_SNAPPING` if configured), `setExpandedMapLoading`, and the unlocked-FPS target. `restoreFpsIfTouched` puts the FPS settings back so disabling the plugin doesn't leave the client in unlocked-FPS mode.

---

## SEGMENT 10 — render pass, attachments, textures, FSR

**HOST:** A few resource classes left. `RenderPass` first — attachments and that `boolean` parameter.

**DEV:** `RenderPass(device, colorFormat, samples, swapchainPresent)`. With MSAA it's three attachments: multisampled color (clear, don't-store), multisampled depth (clear, don't-store, reverse-Z so compare is GREATER and we clear to 0), and a single-sample resolve target (don't-care load, store) that the subpass auto-resolves into. Without MSAA it's color plus depth. The `swapchainPresent` boolean sets the color attachment's final layout: `PRESENT_SRC_KHR` for the normal swapchain path, or `COLOR_ATTACHMENT_OPTIMAL` for the macOS custom present — because on Mac we hand the image to Metal, not to `vkQueuePresentKHR`. And there's a subpass dependency from `EXTERNAL` covering both color and depth, late-fragment to early-fragment, so the single shared depth image from frame N doesn't race frame N+1's depth tests.

**HOST:** `Framebuffers`, `DepthBuffer`, `MsaaColorBuffer` — anything beyond the obvious?

**DEV:** They're straightforward and all support `recreate` for resize without invalidating the `Disposables` references. Attachment order in `Framebuffers` must match the `RenderPass` declaration exactly: MSAA layout is `[msaaColor, depth, swapchainView]`, non-MSAA is `[swapchainView, depth]`. The `MetalDrawableSet` builds its framebuffers the same way for the imported drawable. Depth is `D32_SFLOAT`; MSAA color carries the `TRANSIENT_ATTACHMENT` hint so tiled GPUs never spill it to main memory.

**HOST:** `TextureArray` — the OSRS textures.

**DEV:** A `2D_ARRAY` image, 128×128, 8 mip levels, one layer per OSRS texture plus layer 0 as solid white for untextured faces. Upload is staging-buffer to base mip, then a blit cascade generates the mips. The sampler is the landmine: magFilter is `NEAREST`, not LINEAR. OSRS encodes alpha as rgb==0, and the fragment shader discards below 0.5; a LINEAR mag filter bilinear-blends transparent texels into their neighbors and the discard fails, so wall transparency breaks. minFilter is LINEAR — safe with the discard. And it builds the animation UBO: 256 std140 vec4 entries, one per layer, holding the per-tick UV scroll vector derived from the texture's animation direction and speed. The vertex shader reads that to scroll water and lava.

**HOST:** And FSR.

**DEV:** `FsrUpscaler`, only constructed when `upscalingMode` is FSR1 and `renderScale < 100`. Two passes built on the `gfx` abstraction: EASU then RCAS, both fullscreen-triangle fragment shaders. The flow in `VulkanRenderer.recordFsrUpscaledPass`: the scene renders into an `OffscreenSceneTarget` at reduced resolution, that's transitioned to shader-read and fed to `recordEasu` which upscales into a second full-res `OffscreenSceneTarget`, that's transitioned and fed to `recordRcas` which sharpens straight into the main framebuffer, and then the UI pass draws on top. `ScreenshotReadback` is the unrelated one — it records a `vkCmdCopyImageToBuffer` so `DrawManager` can grab frames, and it checks `supportsMetalObjects()` to pick the right source layout.

---

## SEGMENT 11 — the landmine index, and where to start reading

**HOST:** If I only memorize the traps before I touch anything, which ones?

**DEV:** Grep the word `LANDMINE` — they're all tagged. The big ones, by blast radius. One: register `FrameSync` before `Swapchain` on the disposables stack or RADV hangs on teardown. Two: `Swapchain.pickFormat` must prefer `B8G8R8A8_UNORM`, not SRGB, or the whole game doubles in brightness. Three: `Swapchain` does a double `vkDeviceWaitIdle` around destroy — one for RADV's silent process-exit, one for MoltenVK #2609 artifacts. Four: in `recordDraw`, bind the vertex buffer at offset zero and shift with `firstVertex`, never a byte offset, or MoltenVK renders nothing. Five: the scene viewport DPI comes from canvas dims, not viewport dims, or clicks land in the wrong place. Six: the texture array sampler mag filter is NEAREST or wall transparency breaks. Seven: every native entry in `rlmtl.m` needs an `@autoreleasepool` or MoltenVK crashes around frame fifty.

**HOST:** And the open wounds — things that are known-broken or mysterious?

**DEV:** Three. The macOS layer-flicker bug is still open — read `CLAUDE.md`'s running notes before you theorize, because a long list of plausible fixes has already been tried and ruled out. The `draw(Projection, …)` method in the plugin that "never runs" but breaks projectiles if you delete it — issue #1, genuinely not understood. And Windows surface code that's written but never executed — issue #4.

**HOST:** Where do I actually start reading to get the whole model in my head?

**DEV:** Same advice as episode two but with the real entry points. Start at `GpuVulkanPlugin.draw(int overlayColor)` — that's the heartbeat. Follow it into `VulkanRenderer.drawFrame`, and read the fence-wait comment slowly. Then follow `recordClearPass` into `renderExtensions.recordRenderPass` and land in `SceneRenderer.recordDraw`. Once `recordDraw` makes sense — the arenas, the skip-pairs, the per-plane roof logic — back up and read `captureScene` and `SceneModelEmitter` to see how the buffer got filled in the first place. Save the platform floor — instance, device, `rlmtl.m` — for last; it's stable and it'll make more sense once the frame loop is in your head. Don't read top-to-bottom alphabetically. Follow the data.

---

## CLOSE — build, run, and the house rules

**HOST:** Before I touch anything — how do I build and run it, and what are the rules of the house?

**DEV:** Build needs JDK 21 Temurin and `glslangValidator` on your PATH — the Gradle build compiles the shaders to SPIR-V. `./gradlew build`. Three ways to run: from your IDE via `GpuVulkanPluginTest#main`, or `./gradlew run`, or `./gradlew shadowJar` for a ~41MB standalone jar that bundles a RuneLite client plus LWJGL natives including MoltenVK — that's the one you hand a tester. Run the jar with `-ea` to match the plugin-hub template's assertions.

**HOST:** And the rules.

**DEV:** They're in `CLAUDE.md` and they're not decoration — they're scar tissue. One: a failed fix is data. If a change doesn't fix the symptom, your causal model is wrong — stop, write down what it rules out, pick a *different* hypothesis family. Don't stack plausible Vulkan fixes. Two: don't diagnose by adding logging and asking someone to paste output — derive it from the code or use validation and RenderDoc. Three: validation being silent under the failure condition means the bug is *not* in Vulkan API usage — it's in MoltenVK translation, AWT integration, present timing, or shader semantics; look there. Four: correlated symptoms share a cause — don't fix the easy adjacent thing and call it progress on the hard one. Five: structural changes need buy-in; patches must be reversible and justified. Six: we depend on RuneLite — no upstream-incompatible hacks.

**HOST:** And commits?

**DEV:** Conventional-commit style. And follow the Linux-kernel attribution convention: where an assistant materially shaped the code, add an `Assisted-by:` trailer below your `Signed-off-by:` line — never `Co-Authored-By:`, because that implies joint authorship an LLM can't hold. Trivial autocomplete needs no trailer.

**HOST:** Last question. If you could leave the next crew one sentence taped to the monitor?

**DEV:** "Follow the data from `draw`, read the scary comments first, and when a fix doesn't work, change your model instead of changing a different line." That's the whole job here.

**HOST:** Taped up. That's the handover.

---

### Appendix — the class map, by role

**Spine / lifecycle**
- `GpuVulkanPlugin` — `Plugin` + `DrawCallbacks` + `VulkanRenderBackend`. Startup/teardown order, the engine callbacks, the frame trigger `draw(int)`.
- `Disposables` — LIFO close-stack; teardown order is encoded here.
- `ClientRuntimeConfig` — applies/restores engine settings (GPU flags, FPS, expanded map, vertex snapping).
- `VulkanExtensionQueue` — pre/post-backend registration for third-party extensions.

**Per-frame engine**
- `VulkanRenderer` — `drawFrame`, `recordClearPass`, swapchain vs custom-present, submit/present, viewport+matrix, FSR pass, screenshot copy.
- `FrameSync` — 3 frames in flight; per-frame `imageAvailable`/`inFlight`, per-image `renderFinished`.
- `Swapchain` — format (UNORM), present-mode selection (mac FIFO), `oldSwapchain` recreate, teardown drains.
- `MetalDrawableSet` — macOS: import `MTLTexture` as `VkImage`, cache by pointer.

**Scene capture + draw**
- `SceneRenderer` — owns the one vertex buffer (static + 3 frame arenas); `captureScene`, `rebuildDirtyZones`, `beginFrame`, `recordDraw`.
- `SceneModelEmitter` — sort-decision (unsorted / cull-only / `ModelSorter`); calls `ModelUvMapper`; records `PriorityRangeSet`.
- `ModelSorter` — depth bucket-sort + priority interleave, ported from stock.
- `SceneTileEmitter` — paint/model tiles → HSL triangles.
- `SceneDrawEmitter` — `drawRange` with skip-pairs (multiple `vkCmdDraw`); per-platform push behavior.
- `SceneZoneDrawScheduler` — `drawStaticPlane`/`drawOverlayPlane`; zone culling; merge roof+overlay skips.
- Helpers: `DirtyZoneTracker` (per-slot bitmask), `RoofRangeSet` (`buildSkipPairs`), `SceneRoofInfo` (`forTile`/`visbelow`), `PriorityRangeSet`, `PendingRenderables` (retry), `ModelFaceCache`, `SceneVertexPacker` (20-byte writes), `ScenePipeline` (vertex layout + push ranges + the 5 pipeline variants).

**Gfx abstraction + UI**
- `Gfx`/`GfxRenderer`/`GfxRenderPipeline`/`GfxRenderEncoder`/`GfxStreamingImage`/`GfxBindGroup`/`GfxShaderModule`/`GfxBindGroupLayout` — the wgpu-style layer.
- `InterfaceRenderer` — UI extension: streaming texture ring, fullscreen-triangle draw, `overlayColor` tint.
- `Buffer` — host-visible buffer + persistent map; `Vk.check` error wrapping.

**Platform floor**
- `VulkanInstance` — extensions, validation+sync, portability flag.
- `VulkanDevice` — GPU/queue pick, device extensions, `metalCommandQueue` via `vkExportMetalObjectsEXT`, capability flags.
- `PlatformSurface` + `X11`/`Win32`/`MacOS` impls + `VulkanSurface` — surface creation per OS.
- `MacOSMetalHelper` + `rlmtl.m` — JNI bridge: `CAMetalLayer`, `CADisplayLink`, `nextDrawable`/`presentDrawable`, autoreleasepools.

**Resources**
- `RenderPass` (reverse-Z, MSAA resolve, `swapchainPresent` final layout) · `Framebuffers` · `DepthBuffer` · `MsaaColorBuffer` · `TextureArray` (white layer 0, NEAREST mag, animation UBO) · `Texture` · `FsrUpscaler` (EASU→RCAS) · `OffscreenSceneTarget` · `ScreenshotReadback`.
