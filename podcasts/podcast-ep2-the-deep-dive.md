# Podcast Script — Episode 2: "The Deep Dive"

> Same two voices as Episode 1. **HOST** is the curious learner; **DEV** built the thing.
> This one is for someone who finished Episode 1 and now wants to open the source and *not
> drown*. We go down to the bytes, the sync primitives, the sort algorithm, and the genuinely
> cursed platform bugs. Still taught, not dumped — every concrete detail comes with the *why*.
> Est. run time: ~35–40 min.
>
> Ground rule for the read: when a number shows up — 20 bytes, 3 frames, depth 0 — say it out
> loud and then say what it *buys you*. A junior remembers the reason, not the number.

---

## COLD OPEN

**HOST:** Episode one you gave me the map. Pipelines are frozen recipes, the command buffer is a notebook, fences and semaphores keep the CPU and GPU from stepping on each other. Today I want to actually open the files and understand what I'm looking at.

**DEV:** Good, because the map lies a little. The map says "capture geometry into a buffer." The territory is: one vertex is exactly twenty bytes laid out in a very specific order, and if you get one byte wrong the whole world turns inside out. Let's go there.

**HOST:** Start with the twenty bytes.

---

## SEGMENT 1 — What one vertex actually is

**DEV:** Okay. Every single point of every model in the world becomes a twenty-byte record. Picture it as three little chunks. First eight bytes: position — x, y, z, each a signed 16-bit short, plus two bytes of padding. Next four bytes: color and some flags, packed into one 32-bit integer. Last eight bytes: texture coordinates and which texture to use.

**HOST:** Why shorts for position? Why not normal floats?

**DEV:** Because the game world's coordinates are integers in the first place — tiles are 128 units across, everything snaps to a grid. A short holds plus-or-minus thirty-two thousand, which covers the scene with room to spare. Half the size of a float. And here's the rule that runs through this entire codebase: the smaller each vertex, the more of them fit in the GPU's cache, the faster it chews through them. You've got hundreds of thousands of these per frame. Eight bytes saved per vertex is real.

**HOST:** And that middle integer — color packed into 32 bits. Unpack it for me.

**DEV:** This is the part that surprises people. The game doesn't store color as red-green-blue. It stores it as **HSL** — hue, saturation, lightness — crammed into 16 bits. Six bits of hue, three of saturation, seven of lightness. So that middle integer is: the low 16 bits are that HSL value, the next byte is a depth "bias," and the top byte is transparency.

**HOST:** Wait, why HSL? Every graphics thing I've ever seen is RGB.

**DEV:** Because the *game* is HSL. It's a 2003 engine. Storing it that way lets the renderer reproduce the exact same faceted, slightly-banded look the original software renderer had. The shader converts HSL to RGB on the GPU, per vertex, using the same math the original client used — it's literally ported line for line with the original author's copyright on it. If you converted to RGB on the way in, you'd lose that fidelity and it'd look subtly wrong. So the packer keeps it HSL all the way to the GPU.

**HOST:** Three values stuffed into one integer though — color, a bias, and transparency. That feels like a magic trick.

**DEV:** It's the whole genre. You'll see it again and again: there are only so many slots you can hand a shader, so you bit-pack. The packer does shifts and masks — color goes in the bottom, bias in the middle byte, transparency on top — and the shader pulls them back out with the mirror-image shifts. Once you've seen the pattern once you can read it anywhere.

**HOST:** And the texture coordinates in the last chunk?

**DEV:** UV coordinates — where on the texture image this point maps to — stored as shorts, multiplied by 256 so fractional values survive as integers. Plus a texture layer number, because all the game's textures live stacked in one big array and you index into it by layer. Texture layer zero is reserved to mean "no texture, just use the color."

---

## SEGMENT 2 — The one giant buffer, and why it's sliced

**HOST:** So all these vertices go into "the buffer." Singular?

**DEV:** One big buffer, but it's deliberately carved into sections, and the carving is the clever bit. The front of the buffer is the **static arena** — the terrain, the walls, the scenery that doesn't change frame to frame. That gets written once when you load a region and then just sits there.

**HOST:** And the rest?

**DEV:** The rest is divided into three **dynamic arenas**, one per frame-in-flight. Remember from episode one we keep three frames going at once. Each of those three frames gets its own slice of the buffer to scribble this frame's moving stuff into — players, NPCs, animated objects.

**HOST:** And the three slices exist because...

**DEV:** Because of the exact race we talked about. The CPU is writing frame six's monsters while the GPU is still reading frame four's. If they shared one slice, six would overwrite four mid-draw. Give each of the three in-flight frames its own slice and they physically cannot collide. The static stuff doesn't need slicing — nobody's rewriting it — so it lives once at the front and every frame just reads it.

**HOST:** That's a really clean idea. Static once, dynamic times three.

**DEV:** It's the memory-layout expression of "three frames in flight." The synchronization and the buffer layout are the same idea viewed from two angles.

---

## SEGMENT 3 — Reverse-Z, or: the depth buffer is upside down on purpose

**HOST:** Okay, I saw something in the frame code that made no sense. When it clears the depth buffer, it clears it to *zero*. Everything I've ever read says clear depth to *one*, the far plane.

**DEV:** Welcome to **reverse-Z**, and it's one of those things that looks like a bug and is actually the single smartest line in the file. Normal setup: near plane is zero, far plane is one, you clear to one, and you keep whatever's *less* — closer. This codebase flips it. Far is zero, near is one, clear to zero, keep whatever's *greater*.

**HOST:** Why would you flip it?

**DEV:** Floating-point precision. Floats have tons of precision near zero and very little far from it. In normal depth, all that precision bunches up at the near plane where you don't need it, and faraway objects fight over the few values left — you get "z-fighting," flickering surfaces in the distance. Flip it, and the dense precision lands out where the distant geometry is. Z-fighting basically vanishes. It's nearly free and it's strictly better, so a lot of modern engines do it.

**HOST:** And that's why the clear value is zero — because zero is now "infinitely far."

**DEV:** Exactly. So when you read `depth(0.0)` in the clear and think "that's backwards," no — that's the far plane, and the whole projection is built to match. The comment in the code literally says "closer equals bigger value," which is the one-line reminder to your future self.

**HOST:** You mentioned a "bias" byte packed into the color. Does that touch depth?

**DEV:** It does, and it's a neat little hack. Some faces need to be nudged in depth so they draw on top of what they're sitting on — think a decal, or the priority stuff we'll get to. So that bias byte gets divided down to a small number and *added to the z* right in the vertex shader, after projection. A tiny shove toward the camera. It's a per-vertex depth offset smuggled through one byte of the color integer.

---

## SEGMENT 4 — The sorter, for real this time

**HOST:** Episode one you hand-waved the transparency sort as "sort back to front." I want the actual algorithm.

**DEV:** Fair, because the real one is more interesting than "sort." It's a **bucket sort by depth**, ported straight from the original client's face-priority sorter — again, ported with the original copyright on it, because matching the game exactly matters more than inventing something clever.

**HOST:** Walk it.

**DEV:** For one model: first you project every vertex — run it through the camera math to find how far from the camera it is. Then for each triangle, you do two checks. One: a **back-face cull**. You take the three corners on screen and compute a cross product — basically, "is this triangle wound clockwise or counter-clockwise as I see it." If it's facing away from you, you throw it out. Roughly half the triangles of any solid object face away; never drawing them is free performance.

**HOST:** And the survivors?

**DEV:** The survivors get dropped into buckets by depth. There's a bucket for each distance value out to the model's diameter. Triangle's average depth is, say, forty-two units from center — it goes in bucket forty-two. It's a linked list per bucket so you can chain multiple triangles into the same one cheaply. Then to produce the final order you just walk the buckets from farthest to nearest and read them out. That's your back-to-front order. No comparison sort, no n-log-n — it's basically counting sort on depth. Fast and stable.

**HOST:** You said there's a trick with a "stamp."

**DEV:** Yeah, and it's worth stealing for your own code. You've got these bucket arrays you reuse for every single model, thousands of times a frame. Clearing them each time — zeroing the whole array — is wasteful. So instead there's a counter that ticks up by one each model, and each bucket records "the last stamp that touched me." When you read a bucket you check: does its stamp match the current model's stamp? If not, it's stale garbage from a previous model, ignore it. You never clear the array. You just invalidate it by bumping a number. When the counter eventually wraps around to zero, *then* you do one real clear. It's lazy invalidation and it's a beautiful little pattern.

**HOST:** And the OSRS "priority face" thing — the cape-over-the-body problem.

**DEV:** That's the harder mode and honestly it's the gnarliest function in the file. The game tags some faces with a priority number, zero to eleven, that overrides pure depth — "draw this *as if* it were at this layer regardless of distance." Things like a player's weapon that should always sit in front of the body. The sorter reproduces the original engine's exact interleaving: it groups faces by priority, computes average depths for certain priority groups — you'll literally see variables for the average of priorities one-and-two, three-and-four, six-and-eight — and splices the high-priority faces in at the right moments. It is not pretty. The comment basically says "this matches the client, do not try to make it elegant." And that's the right call — fidelity beats elegance here.

**HOST:** When does it skip all this?

**DEV:** Two outs. If a model is fully opaque and small, it skips the depth bucketing entirely — there's a cull-only path that just does the back-face check and emits. No point sorting when nothing's transparent. And it bails on the whole model if any vertex projects closer than fifty units — that's the near-plane reject, the same magic number the original uses, and it gives you near-plane clipping for free.

---

## SEGMENT 5 — Push constants: the tiny mailbox to the shaders

**HOST:** How does the shader find out the camera moved, or what the fog color is? That changes every frame.

**DEV:** Through **push constants** — and this is a Vulkan feature worth understanding because it's the fastest way to get a small amount of data to a shader. It's a tiny mailbox, a couple hundred bytes, that you stuff right into the command buffer. No buffer, no descriptor, no allocation — it rides along with the draw command itself. Perfect for things that change every frame and are small.

**HOST:** What's in the mailbox here?

**DEV:** It's laid out by byte offset, and both the code and the shader have to agree on that layout exactly or it's chaos. First sixty-four bytes: the camera matrix — the thing that turns world positions into screen positions. Then a chunk of fog parameters the vertex shader needs: camera position and draw distance. Then a slot of miscellaneous integers — the current game tick lives there, for animating textures. Then, further along, the fragment shader's chunk: fog color and brightness.

**HOST:** They share one mailbox but read different parts.

**DEV:** Right — the vertex shader reads the front, the fragment shader reads the back, by explicit offset. And here's my favorite dirty trick in the whole shader. There's one float that carries *two* values at once. It holds the "smooth banding" setting — a zero-to-one blend — but it also encodes which transparency pass we're in by adding ten, or twenty, on top. So the shader does: integer-divide by ten to recover the pass mode, then subtract that back off to recover the original banding value. Two settings, one float slot.

**HOST:** That is genuinely cursed. Why not two slots?

**DEV:** Slots are scarce and every byte of push constant is precious — there's a hard size limit, sometimes as low as 128 bytes guaranteed. When you're tight, you pack. It's the same instinct as the vertex bit-packing. Once you internalize "space in these mailboxes is expensive," these tricks stop looking insane and start looking obvious.

---

## SEGMENT 6 — Inside the fragment shader

**HOST:** Take me through what happens to a single pixel.

**DEV:** So the fragment shader runs once per pixel of every triangle. First thing it does is check for discards — pixels it should throw away entirely. There's an "invisible" sentinel: if transparency equals exactly 255, that's the engine saying "this face is hidden," and we discard immediately. Then depending on which transparency pass we're in, we discard either the see-through pixels or the solid ones, so each pass only handles its own kind.

**HOST:** Then color.

**DEV:** Two branches. If there's no texture, we produce color from that HSL value — either the smooth interpolated version or a sharp per-pixel HSL-to-RGB decode, depending on the banding setting. If there *is* a texture, we sample it from the big texture array using the UV and layer, and we throw away pixels where the texture is nearly transparent — that's how tree leaves get their ragged edges instead of square cards. Then we tint the texture by the face's lightness so lighting still affects textured surfaces.

**HOST:** And after color?

**DEV:** Three finishing moves, in order, and the order matters. Brightness — raise the color to a power, a gamma curve. Then fog — blend toward the fog color by however much fog the vertex shader computed. Then, if it's on, color-blindness correction — a real matrix-based Daltonization, ported from research, that runs *after* fog so the fog itself gets corrected too. The comment notes that ordering matches the original exactly. Out the bottom comes the pixel, with its alpha set to one-minus-transparency.

**HOST:** And that alpha feeds the transparency trick from episode one.

**DEV:** Alpha-to-coverage, yeah. Instead of true blending for every see-through face, the anti-aliasing hardware turns that alpha into a *number of samples* it lights up. Half-transparent means roughly half the sub-pixel samples get drawn. From a normal viewing distance it reads as transparency, and you skip a whole expensive sorted blending pass. It's an approximation, but it's a cheap one that looks right.

---

## SEGMENT 7 — Fences and semaphores, concretely this time

**HOST:** Episode one I learned fence-is-GPU-to-CPU, semaphore-is-GPU-to-GPU. Now show me where they actually live.

**DEV:** There are exactly three kinds of sync object here and the *counts* tell the story. First: a fence per frame-in-flight. Three frames, three fences. That fence is the leash — before the CPU reuses frame slot one's notebook and memory, it waits on slot one's fence to confirm the GPU finished slot one last time around.

**HOST:** Second?

**DEV:** A semaphore per frame called "image available." When you ask the swapchain for the next image to draw into, that hand-off isn't instant, so the swapchain signals this semaphore when the image is actually ready. The GPU waits on it before it starts drawing. Also three of them, one per frame.

**HOST:** And the third — you made a point of this being different.

**DEV:** The third is "render finished," and it is sized *per swapchain image*, not per frame. This is a subtle bug-magnet and the code has a comment defending the choice. Present — actually showing the image — waits on "render finished." But present's wait can outlive a frame: the same image can get handed back around before you've cycled through your three frame slots. If you tied this semaphore to the frame slot, you could end up waiting on a semaphore that's already been recycled for a different image. So you tie it to the *image*. There are as many of these as the swapchain has images.

**HOST:** That's the kind of thing you'd never guess until it bit you.

**DEV:** And it bit people. That's why the comment exists. The general lesson for a junior: when you're sizing sync objects, ask "what is the lifetime of the thing this guards?" Frame-lifetime stuff gets one-per-frame. Image-lifetime stuff gets one-per-image. Mixing those up is a classic Vulkan footgun.

**HOST:** So the real loop, with the right objects?

**DEV:** Wait on this frame's fence. Reset it. Ask the swapchain for an image, which signals image-available. Record the notebook. Submit it — telling the GPU "wait for image-available before you draw, signal render-finished when you're done, and trip this frame's fence when the whole batch lands." Then present, telling it "wait for render-finished before you show it." Advance to the next frame slot. Three slots, around and around.

---

## SEGMENT 8 — The macOS path has *no semaphores at all*

**HOST:** Okay this is the part I most wanted. You told me macOS is different. How different?

**DEV:** On macOS the entire frame uses *zero* semaphores. None. And that's not laziness — it's a consequence of bypassing the normal present path entirely.

**HOST:** Back up. Why bypass it?

**DEV:** Because on a Mac there's no real Vulkan — it's the MoltenVK translator turning Vulkan into Metal, remember. And the normal Vulkan "present this image" call, run through MoltenVK, had timing problems — frames showing out of order, flickering. So instead of letting MoltenVK manage presentation, the code reaches *through* it and grabs Metal's own machinery directly.

**HOST:** Reaches through how?

**DEV:** There's a Vulkan extension that lets you ask MoltenVK "give me the actual Metal command queue you're using under the hood." We extract that. Now we own the real Metal queue. Each frame we ask the Mac's display layer for its next drawable surface directly, we take the Metal texture behind it and wrap it as a Vulkan image so our normal rendering code can draw into it, we render, and then we tell Metal "present this drawable" on that same queue we extracted.

**HOST:** And the no-semaphores thing falls out of that?

**DEV:** Exactly, and this is the elegant part. Both our rendering work and the present command go onto the *same* Metal queue. Metal guarantees things on one queue run in the order you put them. So the present is automatically after the render — no semaphore needed to enforce it, because the queue itself enforces it. We do still keep the per-frame fence, because the CPU still needs to know when it can reuse the notebook. But the GPU-to-GPU ordering that semaphores normally provide? Metal's queue gives it to us for free.

**HOST:** So Linux and Windows: acquire-image, render, present, with two semaphores. macOS: grab-drawable, render, present-on-the-same-queue, zero semaphores, one fence.

**DEV:** That's the whole divergence in two sentences. And there's a caching detail worth knowing: the Mac's display recycles a small pool of drawables — about three, same number again — and each one brings back the same underlying texture pointer. So there's a little cache keyed by that pointer: first time we see a texture we build the Vulkan wrapper and framebuffer for it, every time after we just look it up. Build three wrappers total, reuse forever, until a resize throws them out.

**HOST:** Three drawables, three frames in flight, three swapchain images. Three is just the number of this whole project.

**DEV:** Triple buffering is the heartbeat. One being shown, one being drawn, one ready to go. Everything's sized to three.

---

## SEGMENT 9 — The landmines (the best part)

**HOST:** Your code comments keep saying "LANDMINE." I want the tour. These feel like the real lessons.

**DEV:** They are. These are the scars. Every one is a bug that cost real days. Let me give you the greatest hits.

**HOST:** Go.

**DEV:** **Landmine one: the color format.** When you pick the format for the screen images, there are two that look identical — one labeled UNORM and one labeled SRGB. Pick SRGB and the GPU helpfully "corrects" your colors with a gamma curve. But the game's art is *already* in display color space. So that correction double-applies and the entire game gets about twice as bright. Washed out. The fix is one line: prefer UNORM. The comment screams about it because it's invisible until you notice the whole game looks bleached.

**HOST:** Subtle and total at the same time.

**DEV:** **Landmine two — and this one's wild: destroying things in the wrong order silently kills the whole program.** On certain Linux drivers — AMD's open-source one — if you destroy a swapchain without first telling the GPU to fully finish its work, the entire Java process just... exits. No crash, no error, no stack trace. It vanishes between two log lines. So there are these `wait for the GPU to go idle` calls sprinkled in very deliberately before teardown, and a comment explaining that without them the process disappears. Imagine debugging "my app exits cleanly for no reason." That's a multi-day bug.

**HOST:** How do you even diagnose something with no error?

**DEV:** You bisect. You add log lines around every teardown step and watch which line is the last one printed. The gap tells you where it died. Brutal but it works. And it taught a real Vulkan lesson: you own the lifetimes now, and "finish all GPU work before you destroy what it was using" is non-negotiable. OpenGL did this for you. Vulkan makes forgetting it fatal.

**HOST:** Give me a Mac one.

**DEV:** **Landmine three: presentation mode on Mac.** Vulkan offers a few ways to pace frames to the screen. One of them, "mailbox," is normally great — always show the freshest frame. But through MoltenVK on the Mac's display layer, mailbox would occasionally present drawables out of order for a single refresh, flashing the previous frame's average color through. So the code forces the plain locked-to-refresh mode on Mac whenever you're not running uncapped. The comment names the exact symptom. That kind of "works everywhere except this one translation layer" bug is the entire personality of macOS support.

**HOST:** There's a flicker theme running through all of these.

**DEV:** There is, and I'll be honest with you on the record: there's a layer-flicker bug on Apple Silicon that's still not fully nailed. Some of these landmines are fixes for *cousins* of it. There's even a fence-wait early in the frame whose comment explicitly ties a race — the CPU overwriting the interface image while the GPU's still reading it — to a "the interface layer intermittently covers and uncovers" symptom. Whether that fully explains the remaining flicker is still open. I'm not going to pretend it's solved just because the segment would end cleaner.

**HOST:** I appreciate that. So when you read a "LANDMINE" comment in this code—

**DEV:** —you're reading a tombstone for a day someone lost. Read them first. They're the cheapest education in the repository. Every one is "here's a thing that looks fine, runs fine on my machine, and is silently wrong somewhere else."

---

## SEGMENT 10 — The abstraction layer, one level deeper

**HOST:** Last episode you said there's a WebGPU-style abstraction over the raw Vulkan so the rendering code isn't drowning in setup. I want one concrete example of it earning its keep.

**DEV:** Best example: the **bind group** — that's the abstraction's name for "a bundle of textures and samplers a shader uses." Naively, you make one bundle and bind it. But remember three frames are in flight, and some textures are *streaming* — being rewritten every frame, like the interface image. If all three frames pointed at one texture, frame six rewrites it while frame four is still reading. The flicker race again.

**HOST:** So the bundle has to be tripled too.

**DEV:** And it is — but the abstraction *hides* that. Under the hood, one logical bind group actually allocates three real descriptor sets, one per frame slot, each pointing at that slot's copy of the streaming texture. The rendering code just says "bind this bind group" and the layer quietly hands over the right slot's version for the current frame. The triple-buffering is real but invisible. That's the abstraction earning its keep: the correctness-critical detail is baked in once, in one place, so no caller can forget it.

**HOST:** That's the same "three slices" idea as the vertex buffer, again.

**DEV:** It is the *same idea a third time*. Static-once-or-streaming-times-three. You've now seen it in the vertex buffer, in the sync objects, and in the bind groups. Once you spot that one pattern, three-quarters of this codebase stops being mysterious. It's the same shape wearing different hats.

---

## CLOSE

**HOST:** Five sentences again, but the deep version — for someone about to read the source.

**DEV:** One. A vertex is twenty bit-packed bytes — short positions, HSL color, texture coords — and the smallness is the point. Two. There's one big vertex buffer split into a static arena plus three dynamic arenas, the depth buffer runs reverse-Z so the clear value is zero and "closer means bigger," and transparency is faked with alpha-to-coverage instead of a sorted blend wherever possible. Three. The face sorter is a depth bucket-sort ported verbatim from the original client, with a stamp trick to avoid clearing arrays and a genuinely hairy priority-interleave path that exists purely to match the game's look. Four. Synchronization is three fences and three image-available semaphores sized per-frame, plus render-finished semaphores sized *per-image* because present outlives a frame — and macOS throws out semaphores entirely by presenting on the same Metal queue it renders on. Five. The "LANDMINE" comments are the real curriculum: wrong color format bleaches the game, wrong teardown order silently kills the process, wrong present mode flickers only on Apple — read those before you touch anything.

**HOST:** And if I'm reading the code tonight, where's the single best starting line?

**DEV:** Open the renderer's per-frame function and find the fence wait near the top — the one with the comment about the interface layer covering and uncovering. Read that comment slowly. It contains, in one paragraph, the frame ordering, the three-frames-in-flight race, the streaming-texture problem, and a real unsolved bug. It's the whole project compressed into one defensive `wait`. Start there, then pull every thread it mentions.

**HOST:** Pull the threads from the scariest comment. I love that even more than episode one's advice.

**DEV:** The scary comments are where the knowledge actually lives. The clean code is just the part that already worked.

---

### Appendix — Episode 2 glossary

- **HSL color** — hue/saturation/lightness packed in 16 bits; the game's native color format, converted to RGB on the GPU to preserve the original look.
- **Bit-packing** — stuffing several values into one integer (or one float) with shifts and masks, because shader input slots and push-constant space are scarce.
- **Static / dynamic arena** — the vertex buffer is one static section (terrain, written once) plus three per-frame sections (moving objects), so the CPU and GPU never write/read the same slice.
- **Reverse-Z** — far plane is 0, near plane is 1, clear to 0, keep the larger value. Puts floating-point precision where distant geometry needs it; kills z-fighting.
- **Depth bias** — a per-vertex nudge in depth (carried in one byte of the color int) so certain faces draw on top of what they sit on.
- **Bucket sort (by depth)** — the transparency sort: drop triangles into per-distance buckets, read buckets far-to-near. Linear, not comparison-based.
- **Stamp trick** — invalidate reused arrays by bumping a counter instead of clearing them; a slot is stale unless its stamp matches the current one.
- **Back-face cull** — drop triangles facing away from the camera via a screen-space cross-product sign. Roughly halves the triangles for free.
- **Priority faces** — the game's hint that some faces draw at a fixed layer regardless of distance; reproduced exactly to match the original client.
- **Push constants** — a tiny (~hundreds of bytes) data mailbox that rides inside the command buffer; fastest way to feed small per-frame data (matrix, fog, tick) to shaders.
- **Alpha-to-coverage** — the anti-aliasing hardware turns a pixel's alpha into a count of lit sub-samples, faking transparency without a sorted blend pass.
- **Fence** — GPU→CPU "I'm done, reuse this." One per frame-in-flight (three).
- **image-available semaphore** — swapchain→GPU "your image is ready to draw into." One per frame (three).
- **render-finished semaphore** — render→present "drawing is done, safe to show." One per *image*, because present can outlive a frame slot.
- **Custom present (macOS)** — bypass the normal Vulkan present; extract Metal's command queue through an extension, grab drawables directly, present on the same queue so ordering is free and no semaphores are needed.
- **LANDMINE comment** — the codebase's tag for a bug that looks fine and is silently wrong elsewhere (color format, teardown order, present mode). The fastest way to learn the real constraints.
