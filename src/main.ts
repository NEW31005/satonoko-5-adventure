import Phaser from "phaser";
import "./styles.css";
import { BossScene } from "./scenes/BossScene";
import { ClearScene } from "./scenes/ClearScene";
import { GameScene } from "./scenes/GameScene";
import { TitleScene } from "./scenes/TitleScene";

const syncAppViewport = (): void => {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;

  document.documentElement.style.setProperty("--app-width", `${Math.floor(width)}px`);
  document.documentElement.style.setProperty("--app-height", `${Math.floor(height)}px`);
};

syncAppViewport();

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

const game = new Phaser.Game(config);

const refreshLayout = (): void => {
  syncAppViewport();
  window.setTimeout(() => game.scale.refresh(), 60);
};

window.addEventListener("resize", refreshLayout, { passive: true });
window.addEventListener("orientationchange", () => {
  window.setTimeout(refreshLayout, 150);
  window.setTimeout(refreshLayout, 450);
});
window.visualViewport?.addEventListener("resize", refreshLayout, { passive: true });
window.visualViewport?.addEventListener("scroll", refreshLayout, { passive: true });
