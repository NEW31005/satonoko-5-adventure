import Phaser from "phaser";

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  private speed = 48;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly minX: number,
    private readonly maxX: number,
  ) {
    super(scene, x, y, "turtleEnemySheet", 0);
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.setDepth(12);
    this.setOrigin(0.5, 1);
    this.setDisplaySize(78, 88);
    this.setVelocityX(this.speed);
    this.setFlipX(true);
    this.play("turtle-enemy-walk", true);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.setSize(this.frame.width * 0.62, this.frame.height * 0.66, true);
    body.setOffset(this.frame.width * 0.19, this.frame.height * 0.31);
    body.setBounce(0, 0);
  }

  update(): void {
    if (!this.active) {
      return;
    }

    if (this.x <= this.minX) {
      this.setVelocityX(this.speed);
      this.setFlipX(true);
    } else if (this.x >= this.maxX) {
      this.setVelocityX(-this.speed);
      this.setFlipX(false);
    }
  }
}
