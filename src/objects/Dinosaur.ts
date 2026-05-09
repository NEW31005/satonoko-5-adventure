import Phaser from "phaser";

export class Dinosaur extends Phaser.Physics.Arcade.Sprite {
  readonly expiresAt: number;
  private readonly laneY: number;
  private readonly chargeSpeed: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    direction: number,
    speed: number,
    lifetimeMs: number,
  ) {
    super(scene, x, y, "chibitiraSheet", 0);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.expiresAt = scene.time.now + lifetimeMs;
    this.laneY = y;
    this.chargeSpeed = speed;
    this.setOrigin(0.5, 1);
    this.setDepth(18);
    this.setDisplaySize(64, 76);
    this.setFlipX(false);
    this.setVelocity(speed, 0);
    this.setAcceleration(0, 0);
    this.setGravityY(0);
    this.play("chibitira-run", true);

    const body = this.body as Phaser.Physics.Arcade.Body;
    body.allowGravity = false;
    body.immovable = true;
    body.moves = true;
    body.setSize(this.frame.width * 0.68, this.frame.height * 0.52, true);
    body.setOffset(this.frame.width * 0.16, this.frame.height * 0.4);
  }

  update(now: number): void {
    if (now >= this.expiresAt) {
      this.destroy();
      return;
    }

    this.y = this.laneY;
    this.setVelocity(this.chargeSpeed, 0);
    this.rotation = Math.sin(now / 90) * 0.03;
  }
}
