import Phaser from "phaser";

export class ClearScene extends Phaser.Scene {
  constructor() {
    super("ClearScene");
  }

  create(data: { score?: number; stars?: number }): void {
    this.cameras.main.setBackgroundColor("#fffaf0");

    const score = data.score ?? 0;
    const stars = data.stars ?? 0;

    this.add
      .text(480, 86, "ステージクリア！", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "48px",
        fontStyle: "900",
        color: "#4a2a10",
        stroke: "#ffffff",
        strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.add.image(480, 285, "lineup").setDisplaySize(720, 360);

    this.add
      .text(480, 448, `スコア ${score}   スター ${stars}`, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "24px",
        fontStyle: "700",
        color: "#3e5f71",
      })
      .setOrigin(0.5);

    this.add
      .text(480, 496, "Space でもう一度", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "22px",
        color: "#ffffff",
        backgroundColor: "#2f7ac8",
        padding: { x: 24, y: 10 },
      })
      .setOrigin(0.5);

    this.input.keyboard?.once("keydown-SPACE", () => {
      this.scene.start("GameScene");
    });
  }
}
