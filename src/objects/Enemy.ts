import Phaser from "phaser";

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  private speed = 55;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly minX: number,
    private readonly maxX: number,
  ) {
    super(scene, x, y, "slime");
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(12);
    this.setDisplaySize(54, 34);
    this.setVelocityX(this.speed);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(44, 24, true);
    body.setBounce(0, 0);
  }

  update(): void {
    if (!this.active) {
      return;
    }

    if (this.x <= this.minX) {
      this.setVelocityX(this.speed);
      this.setFlipX(false);
    } else if (this.x >= this.maxX) {
      this.setVelocityX(-this.speed);
      this.setFlipX(true);
    }
  }
}
