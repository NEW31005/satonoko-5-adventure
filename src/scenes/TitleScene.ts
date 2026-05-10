import Phaser from "phaser";
import { characterOrder, characters } from "../data/characters";

const assetPath = `${import.meta.env.BASE_URL}assets/characters`;
const bossAssetPath = `${import.meta.env.BASE_URL}assets/boss`;

export class TitleScene extends Phaser.Scene {
  constructor() {
    super("TitleScene");
  }

  preload(): void {
    this.load.image("lineup", `${assetPath}/lineup.png`);
    this.load.image("lineupTitle", `${assetPath}/lineup_title.png`);
    this.load.image("inori", `${assetPath}/inori.png`);
    this.load.image("yuri", `${assetPath}/yuri.png`);
    this.load.image("matsuri", `${assetPath}/matsuri.png`);
    this.load.image("shiori", `${assetPath}/shiori.png`);
    this.load.image("akari", `${assetPath}/akari.png`);
    this.load.image("chibitira", `${assetPath}/chibitira.png`);
    this.load.image("finalBoss", `${bossAssetPath}/final_boss.png`);
    characterOrder.forEach((id) => {
      const character = characters[id];
      this.load.image(character.iconKey, `${assetPath}/icons/${id}_face.png`);
      this.load.spritesheet(character.sheetKey, `${assetPath}/sheets/${id}_sheet.png`, {
        frameWidth: character.frameWidth,
        frameHeight: character.frameHeight,
      });
    });
    this.load.spritesheet("chibitiraSheet", `${assetPath}/sheets/chibitira_sheet.png`, {
      frameWidth: 222,
      frameHeight: 335,
    });
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#f9fdff");
    this.addBackground();

    this.add
      .text(480, 62, "さとのこ5きょうだい大冒険", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "42px",
        fontStyle: "900",
        color: "#4a2a10",
        stroke: "#ffffff",
        strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.add
      .text(480, 108, "5人を切り替えて、さとのこ草原をゴールまで進もう", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "20px",
        color: "#5d6470",
      })
      .setOrigin(0.5);

    this.add
      .rectangle(480, 312, 910, 386, 0xffffff, 0.72)
      .setStrokeStyle(2, 0xffffff, 0.85);
    this.add
      .image(665, 318, "finalBoss")
      .setDisplaySize(330, 425)
      .setAlpha(0.26)
      .setTint(0x9b5cff);
    this.add.image(480, 310, "lineupTitle").setDisplaySize(760, 380).setAlpha(0.98);

    const start = this.add
      .text(480, 490, "タップ / Space でスタート", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "24px",
        fontStyle: "700",
        color: "#ffffff",
        backgroundColor: "#2f7ac8",
        padding: { x: 26, y: 12 },
      })
      .setOrigin(0.5);

    this.tweens.add({
      targets: start,
      scale: 1.04,
      duration: 620,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.input.keyboard?.once("keydown-SPACE", () => {
      this.scene.start("GameScene");
    });
    start.setInteractive({ useHandCursor: true }).on("pointerdown", () => {
      this.scene.start("GameScene");
    });
  }

  private addBackground(): void {
    const graphics = this.add.graphics();
    graphics.fillGradientStyle(0xf9fdff, 0xf9fdff, 0xe3f7ff, 0xe3f7ff, 1);
    graphics.fillRect(0, 0, 960, 540);
    graphics.fillStyle(0xffffff, 0.9);
    graphics.fillEllipse(130, 150, 150, 52);
    graphics.fillEllipse(250, 105, 92, 34);
    graphics.fillEllipse(790, 165, 145, 50);
    graphics.fillStyle(0xfff3c4, 0.55);
    graphics.fillCircle(845, 75, 44);
  }
}
