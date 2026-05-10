export type CharacterId = "inori" | "akari" | "shiori" | "yuri" | "matsuri";

export type CharacterRole =
  | "jump"
  | "dash"
  | "flight"
  | "dinosaur_summon"
  | "invincible";

export type CharacterConfig = {
  id: CharacterId;
  name: string;
  kana: string;
  nickname: string;
  role: CharacterRole;
  description: string;
  moveSpeed: number;
  jumpPower: number;
  specialName: string;
  specialAction:
    | "highJump"
    | "dash"
    | "fly"
    | "summonDinosaur"
    | "invincible";
  specialCooldown?: number;
  dashPower?: number;
  flightDuration?: number;
  flightLift?: number;
  summonLimit?: number;
  dinosaurName?: string;
  dinosaurSpeed?: number;
  dinosaurLifetime?: number;
  invincibleDuration?: number;
  color: number;
  uiColor: string;
  assetKey: string;
  sheetKey: string;
  iconKey: string;
  frameWidth: number;
  frameHeight: number;
  displayHeight: number;
};

export const characterOrder = [
  "inori",
  "yuri",
  "matsuri",
  "shiori",
  "akari",
] as const satisfies readonly CharacterId[];

export const characters: Record<CharacterId, CharacterConfig> = {
  inori: {
    id: "inori",
    name: "祈里",
    kana: "いのり",
    nickname: "いーちゃん",
    role: "jump",
    description: "高くジャンプできるお姉ちゃんキャラ",
    moveSpeed: 220,
    jumpPower: 520,
    specialName: "スター・ハイジャンプ",
    specialAction: "highJump",
    specialCooldown: 7.0,
    color: 0x9b5cff,
    uiColor: "#8b4de8",
    assetKey: "inori",
    sheetKey: "inoriSheet",
    iconKey: "inoriIcon",
    frameWidth: 439,
    frameHeight: 762,
    displayHeight: 142,
  },
  akari: {
    id: "akari",
    name: "明里",
    kana: "あかり",
    nickname: "あーちゃん",
    role: "dash",
    description: "すばやく走れるダッシュキャラ",
    moveSpeed: 300,
    jumpPower: 520,
    specialName: "キラキラダッシュ",
    specialAction: "dash",
    dashPower: 2,
    specialCooldown: 7.0,
    color: 0xff6fb7,
    uiColor: "#ff5fae",
    assetKey: "akari",
    sheetKey: "akariSheet",
    iconKey: "akariIcon",
    frameWidth: 442,
    frameHeight: 632,
    displayHeight: 126,
  },
  shiori: {
    id: "shiori",
    name: "汐里",
    kana: "しおり",
    nickname: "しーちゃん",
    role: "flight",
    description: "短い時間だけ空を飛べるキャラ",
    moveSpeed: 220,
    jumpPower: 520,
    specialName: "ふわふわフライト",
    specialAction: "fly",
    flightDuration: 1.15,
    flightLift: -180,
    specialCooldown: 6.5,
    color: 0x78d8ff,
    uiColor: "#3daedf",
    assetKey: "shiori",
    sheetKey: "shioriSheet",
    iconKey: "shioriIcon",
    frameWidth: 415,
    frameHeight: 725,
    displayHeight: 132,
  },
  yuri: {
    id: "yuri",
    name: "優里",
    kana: "ゆうり",
    nickname: "ゆーくん",
    role: "dinosaur_summon",
    description: "恐竜を呼び出して障害物を壊すキャラ",
    moveSpeed: 220,
    jumpPower: 520,
    specialName: "がおがおサモン",
    specialAction: "summonDinosaur",
    summonLimit: 99,
    dinosaurName: "チビティラ",
    dinosaurSpeed: 760,
    dinosaurLifetime: 2.2,
    specialCooldown: 1.4,
    color: 0xff5a3c,
    uiColor: "#e6412d",
    assetKey: "yuri",
    sheetKey: "yuriSheet",
    iconKey: "yuriIcon",
    frameWidth: 495,
    frameHeight: 640,
    displayHeight: 118,
  },
  matsuri: {
    id: "matsuri",
    name: "茉里",
    kana: "まつり",
    nickname: "まーちゃん",
    role: "invincible",
    description: "短い時間だけ無敵になれる小さな切り札キャラ",
    moveSpeed: 180,
    jumpPower: 520,
    specialName: "むてきにこにこタイム",
    specialAction: "invincible",
    invincibleDuration: 3.0,
    specialCooldown: 3.8,
    color: 0xffd700,
    uiColor: "#e6aa00",
    assetKey: "matsuri",
    sheetKey: "matsuriSheet",
    iconKey: "matsuriIcon",
    frameWidth: 399,
    frameHeight: 445,
    displayHeight: 96,
  },
};
