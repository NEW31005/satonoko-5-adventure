import Phaser from "phaser";
import { CharacterConfig, CharacterId, characters } from "../data/characters";

export class Player extends Phaser.Physics.Arcade.Sprite {
  activeId: CharacterId = "inori";
  facing = 1;
  private motionKey = "";

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, characters.inori.sheetKey, 0);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setDepth(20);
    this.setOrigin(0.5, 1);
    this.applyCharacter("inori");

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setCollideWorldBounds(false);
    body.setMaxVelocity(760, 1280);
    body.setDragX(1600);
  }

  get config(): CharacterConfig {
    return characters[this.activeId];
  }

  applyCharacter(id: CharacterId): void {
    this.activeId = id;
    const config = characters[id];
    this.setTexture(config.sheetKey, 0);
    const ratio = this.frame.width / this.frame.height;
    this.setDisplaySize(config.displayHeight * ratio, config.displayHeight);
    this.configureBody();
    this.playMotion("idle");
  }

  playMotion(motion: "idle" | "run" | "jump" | "special"): void {
    const key = `${this.activeId}-${motion}`;
    if (this.motionKey === key && this.anims.isPlaying) {
      return;
    }

    this.motionKey = key;
    if (this.scene.anims.exists(key)) {
      this.play(key, true);
    }
  }

  isGrounded(): boolean {
    const body = this.body as Phaser.Physics.Arcade.Body;
    return body.blocked.down || body.touching.down;
  }

  private configureBody(): void {
    const body = this.body as Phaser.Physics.Arcade.Body | null;
    if (!body) {
      return;
    }

    const widthRatio = this.activeId === "matsuri" ? 0.42 : 0.34;
    const heightRatio = this.activeId === "matsuri" ? 0.76 : 0.72;
    const bodyWidth = this.frame.width * widthRatio;
    const bodyHeight = this.frame.height * heightRatio;

    body.setSize(bodyWidth, bodyHeight, true);
    body.setOffset((this.frame.width - bodyWidth) / 2, this.frame.height - bodyHeight - 4);
  }
}
