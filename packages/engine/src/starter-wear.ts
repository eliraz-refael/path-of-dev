import type { ItemDef, PetSlot, Rarity, WearArt } from "@pathofdev/schema"
import { dressedSize, haloCells } from "@pathofdev/schema"

// The pet's wear in the starter catalogue, each with the art the profile page draws it in: a patch of cells on the
// dressed canvas (`dressedSize`, the pet at `petAt`), in a palette of its own. Each item's `sprite` names its art here,
// so the catalogue says what to draw and this file how. A shape worn in more than one colour is a function of its
// palette. The canvas, by its columns and rows, with the pet on it:
//
//             1111111111
//   0123456789012345678 9
//    4 .....o........o.....      the ears, with room between them for a hat
//    7 ....obbboooobbbo....      the top of the head
//    8 ...obbbbbbbbbbbbo...
//    9 ...obbewbbbbewbbo...      the eyes
//   12 ...obbbbllllbbbbo...      the belly, where a scarf sits
//   15 ......oo....oo......      the feet
//
// Aura and back wear is drawn behind the pet, so it shows only round it; neck, head and hand wear over it.

/** The art of each wearable, by its sprite id. */
export const starterWearArt: Record<string, WearArt> = {}

const wear = (
  id: string,
  name: string,
  rarity: Rarity,
  slot: PetSlot,
  lore: string,
  art: WearArt,
  category: "wearable" | "artefact" = "wearable",
): ItemDef => {
  starterWearArt[id] = art
  return { id, name, rarity, category, slot, sprite: id, lore, effect: null, look: null }
}

const patch = (x: number, y: number, palette: WearArt["palette"], rows: ReadonlyArray<string>): WearArt => ({
  x,
  y,
  rows,
  palette,
})

/** An aura: the cells round the pet, every `every`th of them lit, in `colors` by turn. */
const halo = (colors: ReadonlyArray<string>, every = 1, offset = 0): WearArt => {
  const letters = "abcdefgh"
  const rows = Array.from({ length: dressedSize.height }, () => Array.from({ length: dressedSize.width }, () => "."))
  haloCells.forEach((cell, i) => {
    if ((i + offset) % every !== 0) return
    const line = rows[cell.y]
    if (line !== undefined) line[cell.x] = letters[Math.floor(i / every) % colors.length] ?? "a"
  })
  const palette = Object.fromEntries(colors.map((color, i) => [letters[i] ?? "a", color]))
  return patch(0, 0, palette, rows.map((row) => row.join("")))
}

// Shapes worn in more than one colour.

/** A cap with a button on top and a brim to the right: `k` the crown, `d` the brim and button. */
const cap = (k: string, d: string) =>
  patch(7, 4, { k, d }, [
    "...dd....",
    ".kkkk....",
    "kkkkkk...",
    "ddddddddd",
  ])

/** A cape behind the pet, from its shoulders to a hem past its feet: `c` the cloth, `h` the hem, `s` a speck. */
const cape = (c: string, h: string, s: string) =>
  patch(0, 8, { c, h, s }, [
    "..cccccccccccccccc..",
    ".cccccccccccccccccc.",
    ".cccccccccccccccccs.",
    "cscccccccccccccccccc",
    "cccccccccccccccccccc",
    "ccccccccccccccccccsc",
    "cccscccccccccccccccc",
    "cccccccccccccccccccc",
    "hchchchchchchchchchc",
  ])

/** Wings either side, rising past the ears: `w` the wing, `f` its feathers or bones, `t` the tips. */
const wings = (w: string, f: string, t: string) =>
  patch(0, 4, { w, f, t }, [
    "...t............t...",
    "..tw............wt..",
    ".twf............fwt.",
    "twfw............wfwt",
    "wfww............wwfw",
    "fwwf............fwwf",
    "wwf..............fww",
    "wf................fw",
  ])

/** A pendant on a chain, hanging below the belly: `c` the chain, `d` its rim, `p` the pendant, `g` its glint. */
const pendant = (c: string, d: string, p: string, g: string) =>
  patch(6, 11, { c, d, p, g }, [
    "c......c",
    ".c....c.",
    "..cddc..",
    "..dpgd..",
    "...dd...",
  ])

// The pet's wear, a rarity at a time.

const head: ReadonlyArray<ItemDef> = [
  wear(
    "plain-cap",
    "Plain Cap",
    "common",
    "head",
    "Fits every head, flatters none, never falls off.",
    cap("#8a94a6", "#5c6577"),
  ),
  wear(
    "wool-beanie",
    "Wool Beanie",
    "common",
    "head",
    "Knitted during one very slow CI run.",
    patch(7, 3, { p: "#f4f4f4", k: "#d7875f", r: "#a0603f" }, [
      "..pp..",
      ".kkkk.",
      "kkkkkk",
      "kkkkkk",
      "rrrrrr",
    ]),
  ),
  wear(
    "paper-crown",
    "Paper Crown",
    "common",
    "head",
    "Folded from a printout of the changelog.",
    patch(7, 5, { k: "#f2e3a0", g: "#d75f5f", d: "#c9b46a" }, [
      "k.kk.k",
      "kkggkk",
      "dddddd",
    ]),
  ),
  wear(
    "sprout-clip",
    "Sprout Clip",
    "common",
    "head",
    "It waters itself whenever the tests pass.",
    patch(9, 3, { l: "#87d75f", s: "#5f8f3f", c: "#ff8fb1" }, [
      "l.l",
      "lsl",
      ".s.",
      ".s.",
      "cc.",
    ]),
  ),
  wear(
    "propeller-cap",
    "Propeller Cap",
    "uncommon",
    "head",
    "Spins a little faster near a good idea.",
    patch(7, 2, { r: "#ff5f5f", b: "#5fafff", s: "#3a3a3a", k: "#ffd75f", y: "#5fd75f" }, [
      "rrssbb",
      "..ss..",
      ".kkkk.",
      "kykkyk",
      "kkkkkk",
      "yyyyyy",
    ]),
  ),
  wear(
    "focus-headphones",
    "Focus Headphones",
    "uncommon",
    "head",
    "They play nothing at all. That is the point.",
    patch(4, 3, { k: "#3a3a4a", c: "#5f5f7a", p: "#5fd7d7" }, [
      ".kkkkkkkkkk.",
      "ccc......ccc",
      "cpc......cpc",
      "ccc......ccc",
    ]),
  ),
  wear(
    "daisy-chain",
    "Daisy Chain",
    "uncommon",
    "head",
    "Picked one by one during a long code freeze.",
    patch(6, 5, { w: "#ffffff", y: "#ffd75f", g: "#5faf5f" }, [
      ".w.ww.w.",
      "wywyywyw",
      "gggggggg",
    ]),
  ),
  wear(
    "wizard-hat",
    "Wizard Hat",
    "rare",
    "head",
    "Pointed, patient, and full of half-remembered spells.",
    patch(6, 0, { k: "#5f5fd7", s: "#ffd75f", b: "#3f3f9f" }, [
      ".....k..",
      "....kk..",
      "...kkk..",
      "...ksk..",
      "..kkkk..",
      ".kkkksk.",
      ".kskkkk.",
      "bbbbbbbb",
    ]),
  ),
  wear(
    "tinker-goggles",
    "Tinker Goggles",
    "rare",
    "head",
    "Every diff looks sharper through them.",
    patch(4, 6, { r: "#af875f", g: "#5fd7ff", f: "#ffffff", s: "#5f4f3f" }, [
      "...rr..rr...",
      "sssrgfrrgfss",
      "...rr..rr...",
    ]),
  ),
  wear(
    "thinking-cap",
    "Thinking Cap",
    "epic",
    "head",
    "Lights up a little when the plan clicks.",
    patch(7, 0, { y: "#fff1a8", f: "#ffffff", s: "#a8a8a8", k: "#9d4edd", d: "#5a2a8a", g: "#ffd23f" }, [
      "..yy..",
      ".yffy.",
      "..ss..",
      ".kkkk.",
      "kkgkkk",
      "kkkkgk",
      "kkkkkk",
      "dddddd",
    ]),
  ),
  wear(
    "plumed-helm",
    "Plumed Helm",
    "epic",
    "head",
    "The plume stands up straight when the build goes red.",
    patch(6, 1, { p: "#d70000", q: "#ff5f5f", m: "#c0c8d8", r: "#7a8496", h: "#ffffff" }, [
      ".....pq.",
      "....pqp.",
      "...pp...",
      "..mmmm..",
      ".mhmmmm.",
      "mmrmmrmm",
      "mmmmmmmm",
    ]),
  ),
  wear(
    "evergreen-crown",
    "Evergreen Crown",
    "legendary",
    "head",
    "Grows a new leaf for every day the streak holds.",
    patch(6, 2, { g: "#3fbf5f", y: "#ffd23f", w: "#fff1a8", r: "#ff5f87", e: "#3fd7af", d: "#c99a1f" }, [
      "g..ww..g",
      "y..yy..y",
      "yg.yy.gy",
      "yyyyyyyy",
      "yryyeyry",
      "dddddddd",
    ]),
  ),
]

const neck: ReadonlyArray<ItemDef> = [
  wear(
    "paper-scarf",
    "Paper Scarf",
    "common",
    "neck",
    "Warm enough for a demo, if nobody opens a window.",
    patch(4, 12, { p: "#f2ead0", f: "#b8a878" }, [
      "pppfpppfpppp",
      "........pf..",
      "........fp..",
    ]),
  ),
  wear(
    "bow-tie",
    "Bow Tie",
    "common",
    "neck",
    "For demos, and only for demos.",
    patch(7, 11, { k: "#d75f5f", d: "#9f3f3f" }, [
      "kk..kk",
      "kkddkk",
      "kk..kk",
    ]),
  ),
  wear(
    "lanyard",
    "Lanyard",
    "common",
    "neck",
    "Holds a badge that opens no doors, proudly.",
    patch(6, 11, { s: "#5f87d7", b: "#ffffff", d: "#5f87d7" }, [
      "s......s",
      ".s....s.",
      "..sbbs..",
      "...dd...",
    ]),
  ),
  wear(
    "knit-scarf",
    "Knit Scarf",
    "uncommon",
    "neck",
    "Every stripe a sprint, and not one dropped stitch.",
    patch(4, 12, { r: "#d75f5f", w: "#f4f4f4" }, [
      "rrwwrrwwrrww",
      ".rr.........",
      ".ww.........",
      ".rr.........",
    ]),
  ),
  wear(
    "bell-collar",
    "Bell Collar",
    "uncommon",
    "neck",
    "Rings once for every passing test.",
    patch(4, 12, { r: "#d70057", g: "#ffd23f", d: "#c99a1f" }, [
      "rrrrrrrrrrrr",
      ".....gg.....",
      ".....dd.....",
    ]),
  ),
  wear(
    "silver-locket",
    "Silver Locket",
    "rare",
    "neck",
    "Inside, a tiny picture of the first green build.",
    pendant("#4e4e66", "#8a8aa0", "#e4e4f0", "#5fafff"),
  ),
  wear(
    "comet-pendant",
    "Comet Pendant",
    "epic",
    "neck",
    "Its tail grows longer with every streak day kept.",
    patch(5, 11, { c: "#5a2a8a", w: "#e0aaff", t: "#7b2cbf", u: "#c77dff", p: "#ffffff" }, [
      ".c......c.",
      "..c....c..",
      "...cwwc...",
      ".tuwppw...",
      "....ww....",
    ]),
  ),
]

const back: ReadonlyArray<ItemDef> = [
  wear(
    "canvas-tote",
    "Canvas Tote",
    "common",
    "back",
    "Room for a laptop, a charger and one snack too many.",
    patch(0, 9, { s: "#a89878", b: "#e4d8b8", d: "#5f87af" }, [
      "..s.",
      ".s..",
      "bbbb",
      "bbbb",
      "bddb",
      "bbbb",
    ]),
  ),
  wear(
    "towel-cape",
    "Towel Cape",
    "common",
    "back",
    "Tied on for a hero's afternoon of bug fixing.",
    cape("#5fafd7", "#ffffff", "#87d7ff"),
  ),
  wear(
    "paper-wings",
    "Paper Wings",
    "uncommon",
    "back",
    "Folded from the old spec. They fly better than it read.",
    wings("#f4f4f4", "#c6c6c6", "#ffffff"),
  ),
  wear(
    "trail-pack",
    "Trail Pack",
    "uncommon",
    "back",
    "Packed light: a map, a lamp and a spare idea.",
    patch(0, 8, { r: "#5f8f3f", k: "#3f5f2f", b: "#af875f", d: "#7a5f3f" }, [
      ".rrr............rrr.",
      ".rkr............rkr.",
      "..bb............bb..",
      ".bbb............bbb.",
      ".bdb............bdb.",
      ".bbb............bbb.",
    ]),
  ),
  wear(
    "night-cloak",
    "Night Cloak",
    "rare",
    "back",
    "Stitched from the hours after the last meeting.",
    cape("#34346e", "#6c6cc8", "#ffffaf"),
  ),
  wear(
    "rocket-pack",
    "Rocket Pack",
    "rare",
    "back",
    "Two settings: off, and shipping.",
    patch(1, 8, { t: "#c6c6c6", s: "#8a8a8a", n: "#4e4e4e", f: "#ffaf00", r: "#ff5f00" }, [
      "tt..............tt",
      "ts..............ts",
      "tt..............tt",
      "ts..............ts",
      "tt..............tt",
      "nn..............nn",
      "ff..............ff",
      "r................r",
    ]),
  ),
  wear(
    "drake-wings",
    "Drake Wings",
    "epic",
    "back",
    "Borrowed from a dragon that reviews pull requests.",
    wings("#5f2a8a", "#c77dff", "#e0aaff"),
  ),
  wear(
    "phoenix-wings",
    "Phoenix Wings",
    "legendary",
    "back",
    "They rise again after every revert.",
    wings("#ff5f00", "#ffd23f", "#fff1a8"),
  ),
]

const hand: ReadonlyArray<ItemDef> = [
  wear(
    "coffee-mug",
    "Coffee Mug",
    "common",
    "hand",
    "It says \"works on my machine\" on the side.",
    patch(16, 9, { s: "#c6c6c6", m: "#f4f4f4", h: "#d0d0d0", k: "#8a5f3f" }, [
      ".s..",
      "s.s.",
      "kkk.",
      "mmmh",
      "mmm.",
    ]),
  ),
  wear(
    "rubber-duck",
    "Rubber Duck",
    "common",
    "hand",
    "Hears every bug out, and never interrupts.",
    patch(16, 10, { y: "#ffd75f", e: "#14101f", o: "#ff8700" }, [
      ".yy.",
      ".yeo",
      "yyyy",
      "yyy.",
    ]),
  ),
  wear(
    "pencil",
    "Pencil",
    "common",
    "hand",
    "Chewed at the end, sharp where it counts.",
    patch(17, 7, { p: "#ff8fb1", s: "#c6c6c6", y: "#ffd23f", t: "#e4c89a", g: "#3a3a3a" }, [
      "p",
      "s",
      "y",
      "y",
      "y",
      "y",
      "t",
      "g",
    ]),
  ),
  wear(
    "magnifying-glass",
    "Magnifying Glass",
    "uncommon",
    "hand",
    "For reading stack traces up close.",
    patch(15, 8, { r: "#af875f", g: "#afe4ff", f: "#ffffff", h: "#5f4f3f" }, [
      "..rr.",
      ".rfgr",
      ".rggr",
      "..rr.",
      ".h...",
      "h....",
    ]),
  ),
  wear(
    "brass-lantern",
    "Brass Lantern",
    "rare",
    "hand",
    "Burns brightest in the oldest code.",
    patch(16, 8, { h: "#c99a1f", f: "#af7f1f", y: "#ffd75f", w: "#fff1a8" }, [
      ".h.",
      "h.h",
      "fff",
      "fwf",
      "fyf",
      "fff",
    ]),
  ),
  wear(
    "quill",
    "Quill",
    "rare",
    "hand",
    "Writes commit messages that say why.",
    patch(15, 6, { w: "#f4f4f4", v: "#87afd7", n: "#3a3a4a" }, [
      "....w",
      "...ww",
      "..wwv",
      ".wwv.",
      ".wv..",
      ".v...",
      "n....",
    ]),
  ),
  wear(
    "starlight-staff",
    "Starlight Staff",
    "epic",
    "hand",
    "Two taps on the floor, and the flaky test passes.",
    patch(17, 3, { s: "#e0aaff", o: "#ffffff", w: "#8a5f3f", d: "#5f3f2a" }, [
      ".s.",
      "sos",
      ".s.",
      ".w.",
      ".w.",
      ".d.",
      ".w.",
      ".w.",
      ".w.",
      ".d.",
      ".w.",
      ".w.",
      ".d.",
    ]),
  ),
  wear(
    "moonlit-blade",
    "Moonlit Blade",
    "legendary",
    "hand",
    "Cuts scope cleanly, and never the corners.",
    patch(15, 3, { b: "#b8dcff", B: "#ffffff", g: "#ffd23f", h: "#5f3f8a", p: "#ffd23f" }, [
      "..B..",
      "..Bb.",
      "..Bb.",
      "..Bb.",
      "..Bb.",
      "..Bb.",
      "..Bb.",
      "..Bb.",
      ".gggg",
      "..hh.",
      "..hh.",
      "..pp.",
    ]),
  ),
]

const aura: ReadonlyArray<ItemDef> = [
  wear(
    "static-spark",
    "Static Spark",
    "common",
    "aura",
    "A little crackle from leaning on a wool sweater.",
    halo(["#ffffaf", "#d0d0d0"], 5),
  ),
  wear(
    "firefly-ring",
    "Firefly Ring",
    "uncommon",
    "aura",
    "A few fireflies that like the light of your screen.",
    halo(["#d7ff5f", "#ffd75f"], 3, 1),
  ),
  wear(
    "rune-circle",
    "Rune Circle",
    "rare",
    "aura",
    "Turns slowly, in the order the tests run.",
    halo(["#5fafff", "#5fd7d7"], 2),
  ),
  wear(
    "thunder-halo",
    "Thunder Halo",
    "epic",
    "aura",
    "Hums at the pitch of a passing build.",
    halo(["#c77dff", "#ffffff", "#9d4edd"]),
  ),
  wear(
    "aurora-crown",
    "Aurora Crown",
    "legendary",
    "aura",
    "Said to glow brighter with every merge.",
    halo(["#3fd7af", "#5fafff", "#c77dff", "#3fbf5f"]),
    "artefact",
  ),
]

/** Every piece of the pet's wear, by slot. */
export const starterWear: ReadonlyArray<ItemDef> = [...head, ...neck, ...back, ...hand, ...aura]
