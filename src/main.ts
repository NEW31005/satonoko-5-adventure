import Phaser from "phaser";
import "./styles.css";
import { BossScene } from "./scenes/BossScene";
import { ClearScene } from "./scenes/ClearScene";
import { GameScene } from "./scenes/GameScene";
import { TitleScene } from "./scenes/TitleScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  width: 960,
  height: 540,
  backgroundColor: "#e7f7ff",
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: "arcade",
    arcade: {
      gravity: { x: 0, y: 1100 },
      debug: false,
    },
  },
  scene: [TitleScene, GameScene, BossScene, ClearScene],
};

new Phaser.Game(config);
