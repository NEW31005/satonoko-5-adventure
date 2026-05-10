import Phaser from "phaser";
import { characterOrder, characters } from "../data/characters";
import { defaultDifficultyId, difficulties, DifficultyId } from "../data/difficulty";

const assetPath = `${import.meta.env.BASE_URL}assets/characters`;
const bossAssetPath = `${import.meta.env.BASE_URL}assets/boss`;
const enemyAssetPath = `${import.meta.env.BASE_URL}assets/enemies`;

export class TitleScene extends Phaser.Scene {
  private selectedDifficultyId: DifficultyId = defaultDifficultyId;
  private difficultyButtons: Array<{
    id: DifficultyId;
    box: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
  }> = [];

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
    this.load.image("turtleEnemy", `${enemyAssetPath}/turtle_enemy.png`);
    this.load.spritesheet("turtleEnemySheet", `${enemyAssetPath}/turtle_enemy_sheet.png`, {
      frameWidth: 260,
      frameHeight: 260,
    });
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
      .image(285, 326, "turtleEnemy")
      .setDisplaySize(260, 328)
      .setAlpha(0.2)
      .setTint(0x6caf5f);
    this.add
      .image(665, 318, "finalBoss")
      .setDisplaySize(330, 425)
      .setAlpha(0.26)
      .setTint(0x9b5cff);
    this.add.image(480, 310, "lineupTitle").setDisplaySize(760, 380).setAlpha(0.98);

    this.createDifficultySelector();

    const start = this.add
      .text(480, 504, "タップ / Space でスタート", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "22px",
        fontStyle: "700",
        color: "#ffffff",
        backgroundColor: "#2f7ac8",
        padding: { x: 24, y: 10 },
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

    const startGame = () => {
      this.scene.start("GameScene", { difficulty: this.selectedDifficultyId });
    };

    this.input.keyboard?.on("keydown-A", () => this.selectAdjacentDifficulty(-1));
    this.input.keyboard?.on("keydown-S", () => this.selectAdjacentDifficulty(1));
    this.input.keyboard?.on("keydown-LEFT", () => this.selectAdjacentDifficulty(-1));
    this.input.keyboard?.on("keydown-RIGHT", () => this.selectAdjacentDifficulty(1));
    this.input.keyboard?.once("keydown-SPACE", startGame);
    start.setInteractive({ useHandCursor: true }).on("pointerdown", startGame);
  }

  private createDifficultySelector(): void {
    const ids: DifficultyId[] = ["easy", "normal", "hard"];
    this.difficultyButtons = [];

    this.add
      .text(480, 398, "難易度", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "16px",
        fontStyle: "900",
        color: "#4a2a10",
        backgroundColor: "rgba(255,255,255,0.82)",
        padding: { x: 18, y: 4 },
      })
      .setOrigin(0.5);

    ids.forEach((id, index) => {
      const config = difficulties[id];
      const x = 300 + index * 180;
      const box = this.add
        .rectangle(x, 438, 164, 44, 0xffffff, 0.9)
        .setStrokeStyle(3, config.color, 0.9)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(x, 438, config.label, {
          fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
          fontSize: "18px",
          fontStyle: "900",
          color: "#2d241f",
        })
        .setOrigin(0.5);

      box.on("pointerdown", () => {
        this.selectedDifficultyId = id;
        this.updateDifficultySelector();
      });

      this.difficultyButtons.push({ id, box, label });
    });

    this.updateDifficultySelector();
  }

  private selectAdjacentDifficulty(direction: -1 | 1): void {
    const ids: DifficultyId[] = ["easy", "normal", "hard"];
    const currentIndex = ids.indexOf(this.selectedDifficultyId);
    this.selectedDifficultyId = ids[Phaser.Math.Wrap(currentIndex + direction, 0, ids.length)];
    this.updateDifficultySelector();
  }

  private updateDifficultySelector(): void {
    this.difficultyButtons.forEach(({ id, box, label }) => {
      const config = difficulties[id];
      const selected = id === this.selectedDifficultyId;
      box.setFillStyle(selected ? config.color : 0xffffff, selected ? 0.92 : 0.86);
      box.setStrokeStyle(selected ? 5 : 3, selected ? 0xffffff : config.color, selected ? 1 : 0.9);
      label.setColor(selected ? "#ffffff" : "#2d241f");
      label.setScale(selected ? 1.05 : 1);
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
