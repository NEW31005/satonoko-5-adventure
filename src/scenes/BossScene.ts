import Phaser from "phaser";
import { characterOrder, characters, CharacterId } from "../data/characters";
import { defaultDifficultyId, DifficultyConfig, DifficultyId, difficulties, resolveDifficulty } from "../data/difficulty";
import { Dinosaur } from "../objects/Dinosaur";
import { Player } from "../objects/Player";

type ControlKeys = {
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  up: Phaser.Input.Keyboard.Key;
  space: Phaser.Input.Keyboard.Key;
  special: Phaser.Input.Keyboard.Key;
  previousCharacter: Phaser.Input.Keyboard.Key;
  nextCharacter: Phaser.Input.Keyboard.Key;
  r: Phaser.Input.Keyboard.Key;
};

type VirtualControls = {
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  jumpQueued: boolean;
};

export class BossScene extends Phaser.Scene {
  private player!: Player;
  private boss!: Phaser.Physics.Arcade.Image;
  private bossHitZone!: Phaser.GameObjects.Rectangle;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private dinosaurs!: Phaser.Physics.Arcade.Group;
  private controls!: ControlKeys;
  private uiFx!: Phaser.GameObjects.Graphics;
  private worldFx!: Phaser.GameObjects.Graphics;
  private uiText!: Phaser.GameObjects.Text;
  private abilityText!: Phaser.GameObjects.Text;
  private specialLabelText!: Phaser.GameObjects.Text;
  private topIconImages: Phaser.GameObjects.Image[] = [];
  private selectIconImages: Phaser.GameObjects.Image[] = [];
  private characterIndex = 0;
  private score = 0;
  private starsCollected = 0;
  private difficultyId: DifficultyId = defaultDifficultyId;
  private difficulty: DifficultyConfig = difficulties[defaultDifficultyId];
  private hp = difficulties[defaultDifficultyId].maxHp;
  private maxHp = difficulties[defaultDifficultyId].maxHp;
  private bossHp = 45;
  private readonly bossMaxHp = 45;
  private bossInvulnerableUntil = 0;
  private bossTouchSafeUntil = 0;
  private bossStompChain = 0;
  private bossEvadeTargetX?: number;
  private bossEvadeDirection = -1;
  private damageLockUntil = 0;
  private dashUntil = 0;
  private flightUntil = 0;
  private invincibleUntil = 0;
  private cooldowns: Partial<Record<CharacterId, number>> = {};
  private nextOrbAt = 0;
  private nextBeamAt = 0;
  private beamRect?: Phaser.GameObjects.Rectangle;
  private beamVisuals: Phaser.GameObjects.GameObject[] = [];
  private beamUntil = 0;
  private beamCharging = false;
  private isEnding = false;
  private isGameOver = false;
  private retryLayer?: Phaser.GameObjects.Container;
  private specialPoseUntil = 0;
  private virtualControls: VirtualControls = {
    left: false,
    right: false,
    jumpHeld: false,
    jumpQueued: false,
  };

  constructor() {
    super("BossScene");
  }

  init(data?: { score?: number; stars?: number; difficulty?: DifficultyId }): void {
    this.score = data?.score ?? 0;
    this.starsCollected = data?.stars ?? 0;
    this.difficulty = resolveDifficulty(data?.difficulty);
    this.difficultyId = this.difficulty.id;
    this.maxHp = this.difficulty.maxHp;
  }

  create(): void {
    this.characterIndex = 0;
    this.hp = this.maxHp;
    this.bossHp = this.bossMaxHp;
    this.bossInvulnerableUntil = 0;
    this.bossTouchSafeUntil = 0;
    this.bossStompChain = 0;
    this.bossEvadeTargetX = undefined;
    this.bossEvadeDirection = -1;
    this.damageLockUntil = 0;
    this.dashUntil = 0;
    this.flightUntil = 0;
    this.invincibleUntil = 0;
    this.cooldowns = {};
    this.nextOrbAt = this.time.now + 2200;
    this.nextBeamAt = this.time.now + 2800;
    this.beamUntil = 0;
    this.beamCharging = false;
    this.isEnding = false;
    this.isGameOver = false;
    this.retryLayer = undefined;
    this.specialPoseUntil = 0;
    this.virtualControls = {
      left: false,
      right: false,
      jumpHeld: false,
      jumpQueued: false,
    };

    this.physics.world.setBounds(0, 0, 960, 540);
    this.cameras.main.setBounds(0, 0, 960, 540);
    this.createGeneratedTextures();
    this.createSpriteAnimations();
    this.addBackground();

    this.platforms = this.physics.add.staticGroup();
    this.projectiles = this.physics.add.group({ allowGravity: false });
    this.dinosaurs = this.physics.add.group({ allowGravity: false });
    this.worldFx = this.add.graphics().setDepth(18);

    const ground = this.add.rectangle(480, 515, 960, 50, 0x4f2a63).setDepth(3);
    ground.setStrokeStyle(2, 0xffa8e8, 0.65);
    this.physics.add.existing(ground, true);
    this.platforms.add(ground);

    this.player = new Player(this, 145, 500);
    this.player.setCollideWorldBounds(true);
    this.player.facing = 1;

    this.boss = this.physics.add.image(660, 508, "finalBoss").setOrigin(0.5, 1).setDepth(14);
    this.boss.setDisplaySize(200, 258);
    this.boss.setImmovable(true);
    this.boss.setGravityY(0);
    const bossBody = this.boss.body as Phaser.Physics.Arcade.Body;
    bossBody.allowGravity = false;
    bossBody.setSize(114, 202, true);
    bossBody.setOffset((this.boss.width - 114) / 2, this.boss.height - 216);

    this.bossHitZone = this.add.rectangle(this.boss.x, this.boss.y - 112, 130, 216, 0xff70c7, 0);
    this.physics.add.existing(this.bossHitZone);
    const hitBody = this.bossHitZone.body as Phaser.Physics.Arcade.Body;
    this.configureBossHitBody(hitBody);

    this.physics.add.collider(this.player, this.platforms);
    this.physics.add.overlap(this.player, this.projectiles, (_, projectile) => {
      this.defeatPlayer(projectile as Phaser.GameObjects.GameObject);
    });
    this.physics.add.overlap(this.dinosaurs, this.bossHitZone, (dino) => {
      this.damageBoss(1, (dino as Dinosaur).x, (dino as Dinosaur).y - 40);
      (dino as Dinosaur).destroy();
    });

    this.controls = this.input.keyboard!.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      special: Phaser.Input.Keyboard.KeyCodes.D,
      previousCharacter: Phaser.Input.Keyboard.KeyCodes.A,
      nextCharacter: Phaser.Input.Keyboard.KeyCodes.S,
      r: Phaser.Input.Keyboard.KeyCodes.R,
    }) as ControlKeys;

    this.createUi();
    this.createTouchControls();
    this.showBossIntro();
  }

  update(time: number, delta: number): void {
    if (this.isEnding) {
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.r)) {
      this.restartBoss();
      return;
    }

    if (this.isGameOver) {
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.previousCharacter)) {
      this.switchCharacter(-1);
    } else if (Phaser.Input.Keyboard.JustDown(this.controls.nextCharacter)) {
      this.switchCharacter(1);
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.special)) {
      this.useSpecial();
    }

    this.updateMovement(time);
    this.updateFlight(time);
    this.updateBoss(time, delta);
    this.updateActors(time);
    this.updateBossTouch(time);
    this.updateBeamHit(time);
    this.updateEffects(time);
    this.updateUi(time);

    if (this.player.y > 565) {
      this.takeDamage(undefined, true);
    }
  }

  private createGeneratedTextures(): void {
    if (!this.textures.exists("bossOrb")) {
      const orb = this.add.graphics();
      orb.fillStyle(0x2a053d, 1);
      orb.fillCircle(14, 14, 12);
      orb.fillStyle(0xff6a95, 0.82);
      orb.fillCircle(9, 9, 5);
      orb.lineStyle(3, 0xff9bd8, 1);
      orb.strokeCircle(14, 14, 12);
      orb.generateTexture("bossOrb", 28, 28);
      orb.destroy();
    }

    if (!this.textures.exists("star")) {
      const star = this.add.graphics();
      star.fillStyle(0xffd44d, 1);
      const points: Phaser.Math.Vector2[] = [];
      for (let i = 0; i < 10; i += 1) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const radius = i % 2 === 0 ? 16 : 7;
        points.push(new Phaser.Math.Vector2(18 + Math.cos(angle) * radius, 18 + Math.sin(angle) * radius));
      }
      star.fillPoints(points, true);
      star.generateTexture("star", 36, 36);
      star.destroy();
    }
  }

  private createSpriteAnimations(): void {
    characterOrder.forEach((id) => {
      const character = characters[id];
      const rate = id === "akari" ? 13 : id === "matsuri" ? 7 : 9;
      this.ensureAnimation(`${id}-idle`, character.sheetKey, [0, 1], 2, -1);
      this.ensureAnimation(`${id}-run`, character.sheetKey, [2, 3, 4, 5], rate, -1);
      this.ensureAnimation(`${id}-jump`, character.sheetKey, [6], 1, 0);
      this.ensureAnimation(`${id}-special`, character.sheetKey, [6, 7, 6, 5], rate, 0);
    });
    this.ensureAnimation("chibitira-run", "chibitiraSheet", [0, 1, 2, 3, 4, 5], 11, -1);
  }

  private ensureAnimation(
    key: string,
    textureKey: string,
    frames: number[],
    frameRate: number,
    repeat: number,
  ): void {
    if (this.anims.exists(key)) {
      return;
    }
    this.anims.create({
      key,
      frames: frames.map((frame) => ({ key: textureKey, frame })),
      frameRate,
      repeat,
    });
  }

  private addBackground(): void {
    const bg = this.add.graphics();
    bg.fillGradientStyle(0xfaf6ff, 0xfaf6ff, 0xe7d8ff, 0xfff4de, 1);
    bg.fillRect(0, 0, 960, 540);
    bg.fillStyle(0x3a164e, 0.18);
    bg.fillCircle(690, 250, 210);
    bg.fillCircle(805, 330, 170);
    bg.fillStyle(0xff8fd4, 0.12);
    bg.fillCircle(120, 100, 75);
    bg.lineStyle(2, 0xa85cff, 0.25);
    for (let i = 0; i < 10; i += 1) {
      bg.strokeCircle(720, 505, 120 + i * 18);
    }
  }

  private createUi(): void {
    this.uiFx = this.add.graphics().setDepth(100).setScrollFactor(0);
    this.topIconImages = [];
    this.selectIconImages = [];
    this.uiText = this.add
      .text(34, 24, "", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "16px",
        fontStyle: "700",
        color: "#32261f",
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.specialLabelText = this.add
      .text(22, 105, "SPECIAL", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "12px",
        fontStyle: "900",
        color: "#4b5360",
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.abilityText = this.add
      .text(30, 129, "", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "15px",
        fontStyle: "700",
        color: "#32261f",
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.createHomeButton();
  }

  private createHomeButton(): void {
    const x = 840;
    const y = 132;
    const width = 158;
    const height = 30;
    const borderColor = 0x7bc9e8;

    const shadow = this.add
      .rectangle(x + 3, y + 4, width, height, 0x2f3a45, 0.14)
      .setDepth(153)
      .setScrollFactor(0);
    const bg = this.add
      .rectangle(x, y, width, height, 0xffffff, 0.9)
      .setDepth(154)
      .setScrollFactor(0)
      .setStrokeStyle(3, borderColor, 0.9);
    const house = this.add.graphics().setDepth(155).setScrollFactor(0);
    house.lineStyle(3, borderColor, 0.95);
    house.strokeTriangle(x - 65, y - 3, x - 53, y - 13, x - 41, y - 3);
    house.strokeRect(x - 60, y - 3, 14, 12);

    const label = this.add
      .text(x + 16, y, "タイトルに戻る", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "13px",
        fontStyle: "900",
        color: "#3d332a",
      })
      .setOrigin(0.5)
      .setDepth(155)
      .setScrollFactor(0);

    const hit = this.add
      .zone(x, y, width + 10, height + 8)
      .setDepth(156)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true });
    const goHome = () => {
      this.virtualControls = {
        left: false,
        right: false,
        jumpHeld: false,
        jumpQueued: false,
      };
      this.scene.start("TitleScene");
    };
    hit.on("pointerdown", () => {
      bg.setFillStyle(0xe9f8ff, 0.96);
      bg.setScale(1.03);
      label.setScale(1.03);
      goHome();
    });
    hit.on("pointerover", () => {
      bg.setFillStyle(0xf5fcff, 0.96);
    });
    hit.on("pointerout", () => {
      bg.setFillStyle(0xffffff, 0.9);
      bg.setScale(1);
      label.setScale(1);
    });

    shadow.setData("homeButton", true);
    bg.setData("homeButton", true);
    label.setData("homeButton", true);
  }

  private createTouchControls(): void {
    this.input.addPointer(4);
    this.createCharacterIconButtons();

    this.addHoldButton(86, 462, "JUMP", 0xffd84d, () => {
      this.virtualControls.jumpHeld = true;
      this.virtualControls.jumpQueued = true;
    }, () => {
      this.virtualControls.jumpHeld = false;
    }, 78, 78, "#3a2c13", "15px");

    this.addTapButton(206, 462, "SPECIAL", 0x9b5cff, 0xffffff, () => {
      this.useSpecial();
    }, 78, "12px");

    this.addMovePad(820, 466);
  }

  private createCharacterIconButtons(): void {
    const positions: Record<CharacterId, { x: number; y: number }> = {
      inori: { x: 62, y: 270 },
      akari: { x: 132, y: 270 },
      shiori: { x: 38, y: 330 },
      yuri: { x: 108, y: 330 },
      matsuri: { x: 178, y: 330 },
    };
    const iconOrder: CharacterId[] = ["inori", "akari", "shiori", "yuri", "matsuri"];

    iconOrder.forEach((id) => {
      const character = characters[id];
      const { x, y } = positions[id];
      const halo = this.add
        .circle(x, y, 24, 0xffffff, 0.82)
        .setDepth(154)
        .setScrollFactor(0)
        .setStrokeStyle(2, character.color, 0.9);
      const icon = this.add
        .image(x, y, character.iconKey)
        .setDisplaySize(42, 42)
        .setDepth(156)
        .setScrollFactor(0)
        .setInteractive({ useHandCursor: true });
      icon.setData("halo", halo);
      icon.setData("characterId", id);
      icon.on("pointerdown", () => {
        this.selectCharacter(id);
      });
      this.selectIconImages.push(icon);
    });
  }

  private addMovePad(x: number, y: number): void {
    this.add
      .text(x, y - 58, "いどう", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "13px",
        fontStyle: "700",
        color: "#426070",
        backgroundColor: "rgba(255,255,255,0.72)",
        padding: { x: 8, y: 3 },
      })
      .setOrigin(0.5)
      .setDepth(156)
      .setScrollFactor(0);

    this.addMoveButton(x - 56, y, "←", () => {
      this.virtualControls.left = true;
      this.virtualControls.right = false;
    }, () => {
      this.virtualControls.left = false;
    });

    this.addMoveButton(x + 56, y, "→", () => {
      this.virtualControls.right = true;
      this.virtualControls.left = false;
    }, () => {
      this.virtualControls.right = false;
    });
  }

  private addMoveButton(
    x: number,
    y: number,
    label: string,
    onDown: () => void,
    onUp: () => void,
  ): void {
    const radius = 42;
    const bg = this.add
      .circle(x, y, radius, 0x2f7ac8, 0.82)
      .setDepth(154)
      .setScrollFactor(0)
      .setStrokeStyle(4, 0xffffff, 0.92)
      .setInteractive({ useHandCursor: true });
    this.add.circle(x - 12, y - 14, 10, 0xffffff, 0.2).setDepth(155).setScrollFactor(0);
    const text = this.add
      .text(x, y, label, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "34px",
        fontStyle: "900",
        color: "#ffffff",
      })
      .setOrigin(0.5)
      .setDepth(156)
      .setScrollFactor(0);

    bg.on("pointerdown", () => {
      bg.setAlpha(1);
      bg.setScale(1.05);
      text.setScale(1.05);
      onDown();
    });
    const release = () => {
      bg.setAlpha(0.82);
      bg.setScale(1);
      text.setScale(1);
      onUp();
    };
    bg.on("pointerup", release);
    bg.on("pointerout", release);
    bg.on("pointerupoutside", release);
  }

  private addHoldButton(
    x: number,
    y: number,
    label: string,
    color: number,
    onDown: () => void,
    onUp: () => void,
    width = 70,
    height = 58,
    textColor = "#ffffff",
    fontSize = label.length > 1 ? "15px" : "28px",
  ): void {
    const radius = Math.max(width, height) / 2;
    const bg = this.add
      .circle(x, y, radius, color, 0.84)
      .setDepth(155)
      .setScrollFactor(0)
      .setStrokeStyle(4, 0xffffff, 0.92)
      .setInteractive({ useHandCursor: true });
    this.add
      .circle(x - radius * 0.22, y - radius * 0.24, radius * 0.22, 0xffffff, 0.22)
      .setDepth(156)
      .setScrollFactor(0);
    const text = this.add
      .text(x, y, label, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize,
        fontStyle: "900",
        color: textColor,
      })
      .setOrigin(0.5)
      .setDepth(156)
      .setScrollFactor(0);

    bg.on("pointerdown", () => {
      bg.setAlpha(1);
      bg.setScale(1.04);
      text.setScale(1.04);
      onDown();
    });
    const release = () => {
      bg.setAlpha(0.78);
      bg.setScale(1);
      text.setScale(1);
      onUp();
    };
    bg.on("pointerup", release);
    bg.on("pointerout", release);
  }

  private addTapButton(
    x: number,
    y: number,
    label: string,
    color: number,
    textColorNumber: number,
    onTap: () => void,
    size = 56,
    fontSize = "22px",
  ): void {
    const textColor = `#${textColorNumber.toString(16).padStart(6, "0")}`;
    const bg = this.add
      .circle(x, y, size / 2, color, 0.86)
      .setDepth(155)
      .setScrollFactor(0)
      .setStrokeStyle(4, 0xffffff, 0.92)
      .setInteractive({ useHandCursor: true });
    this.add.circle(x - size * 0.13, y - size * 0.15, size * 0.11, 0xffffff, 0.22).setDepth(156).setScrollFactor(0);
    this.add
      .text(x, y, label, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize,
        fontStyle: "900",
        color: textColor,
      })
      .setOrigin(0.5)
      .setDepth(156)
      .setScrollFactor(0);

    bg.on("pointerdown", () => {
      bg.setAlpha(1);
      bg.setScale(1.06);
      onTap();
      this.time.delayedCall(120, () => {
        bg.setAlpha(0.82);
        bg.setScale(1);
      });
    });
  }

  private showBossIntro(): void {
    const text = this.add
      .text(480, 150, "ラスボス戦", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "42px",
        fontStyle: "900",
        color: "#4a164d",
        stroke: "#ffffff",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(320)
      .setScrollFactor(0);
    this.tweens.add({
      targets: text,
      alpha: 0,
      y: 118,
      delay: 950,
      duration: 650,
      ease: "Quad.easeIn",
      onComplete: () => text.destroy(),
    });
  }

  private updateMovement(time: number): void {
    const config = this.player.config;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const left = this.controls.left.isDown || this.virtualControls.left;
    const right = this.controls.right.isDown || this.virtualControls.right;
    const speedBoostActive = this.player.activeId === "akari" && time < this.dashUntil;
    const speedMultiplier = speedBoostActive ? characters.akari.dashPower ?? 2 : 1;
    const moveSpeed = config.moveSpeed * speedMultiplier;

    if (left) {
      this.player.facing = -1;
      this.player.setFlipX(true);
      this.player.setVelocityX(-moveSpeed);
    } else if (right) {
      this.player.facing = 1;
      this.player.setFlipX(false);
      this.player.setVelocityX(moveSpeed);
    } else {
      this.player.setVelocityX(Phaser.Math.Linear(body.velocity.x, 0, 0.26));
    }

    const jumpPressed = Phaser.Input.Keyboard.JustDown(this.controls.space) || this.virtualControls.jumpQueued;
    this.virtualControls.jumpQueued = false;
    if (jumpPressed && this.player.isGrounded()) {
      this.player.setVelocityY(-config.jumpPower);
    }

    if (time < this.specialPoseUntil) {
      this.player.playMotion("special");
    } else if (!this.player.isGrounded()) {
      this.player.playMotion("jump");
    } else if (left || right || Math.abs(body.velocity.x) > 40) {
      this.player.playMotion("run");
    } else {
      this.player.playMotion("idle");
    }
  }

  private updateFlight(time: number): void {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const flying = this.player.activeId === "shiori" && time < this.flightUntil;
    body.allowGravity = !flying;
    if (flying) {
      const lift =
        this.controls.space.isDown || this.controls.up.isDown || this.virtualControls.jumpHeld
          ? -210
          : characters.shiori.flightLift ?? -180;
      const drift = this.controls.left.isDown || this.controls.right.isDown || this.virtualControls.left || this.virtualControls.right ? 0 : 20;
      this.player.setVelocityY(lift + drift);
    }
  }

  private updateBoss(time: number, delta: number): void {
    if (this.bossEvadeTargetX !== undefined) {
      const step = 430 * (delta / 1000) * this.bossEvadeDirection;
      const nextX = this.boss.x + step;
      const reached =
        (this.bossEvadeDirection < 0 && nextX <= this.bossEvadeTargetX) ||
        (this.bossEvadeDirection > 0 && nextX >= this.bossEvadeTargetX);

      this.boss.x = reached ? this.bossEvadeTargetX : Phaser.Math.Clamp(nextX, 190, 820);
      this.boss.y = 508 + Math.sin(time / 120) * 7;
      this.boss.setFlipX(this.bossEvadeDirection > 0);
      this.boss.rotation = Math.sin(time / 90) * 0.04;
      this.syncBossHitZone();

      if (reached) {
        this.bossEvadeTargetX = undefined;
        this.bossStompChain = 0;
        this.bossTouchSafeUntil = time + 360;
        this.nextOrbAt = time + 1200;
        this.nextBeamAt = time + 1900;
      }
      return;
    }

    const sideToPlayer = this.player.x < this.boss.x ? -1 : 1;
    const distance = 190 + Math.sin(time / 820) * 70;
    const targetX = Phaser.Math.Clamp(this.player.x - sideToPlayer * distance, 210, 800);
    const speed = Phaser.Math.Clamp((targetX - this.boss.x) * 0.55, -92, 92);
    if (Math.abs(speed) > 4) {
      this.bossEvadeDirection = speed > 0 ? 1 : -1;
    }
    this.boss.x = Phaser.Math.Clamp(this.boss.x + speed * (delta / 1000), 190, 820);
    this.boss.y = 508 + Math.sin(time / 560) * 5;
    this.boss.setFlipX(sideToPlayer > 0);
    this.boss.rotation = Math.sin(time / 850) * 0.018;
    this.syncBossHitZone();

    if (time >= this.nextOrbAt && !this.beamRect && !this.beamCharging) {
      this.fireOrbs();
      this.nextOrbAt = time + Phaser.Math.Between(2900, 3800);
    }

    if (time >= this.nextBeamAt) {
      if (this.hasActiveBossOrbs()) {
        this.nextBeamAt = time + 700;
      } else {
        this.fireBeam();
        this.nextBeamAt = time + Phaser.Math.Between(4300, 5400);
      }
    }

    if (this.beamRect && time >= this.beamUntil) {
      this.clearBeam();
    }
  }

  private configureBossHitBody(body: Phaser.Physics.Arcade.Body): void {
    body.allowGravity = false;
    body.immovable = true;
    body.moves = false;
    body.setSize(130, 216, true);
  }

  private syncBossHitZone(): void {
    const x = this.boss.x;
    const y = this.boss.y - 112;
    this.bossHitZone.setPosition(x, y);
    let hitBody = this.bossHitZone.body as Phaser.Physics.Arcade.Body | undefined;
    if (!hitBody) {
      this.physics.add.existing(this.bossHitZone);
      hitBody = this.bossHitZone.body as Phaser.Physics.Arcade.Body | undefined;
      if (!hitBody) {
        return;
      }
      this.configureBossHitBody(hitBody);
    }
    hitBody.reset(x, y);
  }

  private updateActors(time: number): void {
    this.dinosaurs.getChildren().forEach((dino) => {
      const dinosaur = dino as Dinosaur;
      dinosaur.update(time);
      if (dinosaur.active && (dinosaur.x < -80 || dinosaur.x > 1040)) {
        dinosaur.destroy();
      }
    });
    this.projectiles.getChildren().forEach((projectile) => {
      const sprite = projectile as Phaser.Physics.Arcade.Sprite;
      sprite.rotation += 0.08;
      if (sprite.x < -40 || sprite.x > 1000 || sprite.y < -40 || sprite.y > 580) {
        sprite.destroy();
      }
    });
  }

  private hasActiveBossOrbs(): boolean {
    return this.projectiles.getChildren().some((projectile) => projectile.active);
  }

  private updateBossTouch(time: number): void {
    if (time < this.bossTouchSafeUntil) {
      return;
    }

    const playerBounds = this.player.getBounds();
    const bodyRect = this.getBossBodyRect();
    if (!Phaser.Geom.Intersects.RectangleToRectangle(playerBounds, bodyRect)) {
      return;
    }

    if (this.isAkariDashActive(time)) {
      return;
    }

    if (this.isMatsuriInvincible(time)) {
      return;
    }

    const headRect = this.getBossHeadRect();
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    const isStomp =
      playerBody.velocity.y > 90 &&
      playerBounds.bottom <= headRect.bottom + 34 &&
      Phaser.Geom.Intersects.RectangleToRectangle(playerBounds, headRect);

    if (isStomp) {
      this.damageBoss(3, this.player.x, this.player.y - this.player.displayHeight);
      this.registerBossStomp(time);
      this.bossTouchSafeUntil = time + 520;
      this.player.setVelocityY(-650);
      return;
    }

    this.takeDamage();
  }

  private updateBeamHit(time: number): void {
    if (
      !this.beamRect ||
      time >= this.beamUntil ||
      this.player.activeId === "matsuri" ||
      this.isMatsuriInvincible(time) ||
      this.isAkariDashActive(time)
    ) {
      return;
    }

    if (Phaser.Geom.Intersects.RectangleToRectangle(this.player.getBounds(), this.beamRect.getBounds())) {
      this.takeDamage();
    }
  }

  private updateEffects(time: number): void {
    this.worldFx.clear();
    if (this.player.activeId === "matsuri" && time < this.invincibleUntil) {
      this.worldFx.lineStyle(4, 0xffd700, 0.75);
      this.worldFx.fillStyle(0xffeaa0, 0.12);
      this.worldFx.fillCircle(this.player.x, this.player.y - 48, 56);
      this.worldFx.strokeCircle(this.player.x, this.player.y - 48, 56 + Math.sin(time / 90) * 3);
    }
    if (this.player.activeId === "shiori" && time < this.flightUntil) {
      this.worldFx.lineStyle(3, 0x78d8ff, 0.5);
      this.worldFx.beginPath();
      this.worldFx.arc(this.player.x - 28, this.player.y - 76, 34, -0.9, 1.2, true);
      this.worldFx.arc(this.player.x + 28, this.player.y - 76, 34, 1.9, 4.1, true);
      this.worldFx.strokePath();
    }
    if (this.player.activeId === "akari" && time < this.dashUntil) {
      this.worldFx.lineStyle(4, characters.akari.color, 0.45);
      for (let i = 0; i < 5; i += 1) {
        const x = this.player.x - this.player.facing * (42 + i * 18);
        this.worldFx.lineBetween(x, this.player.y - 70 + i * 9, x - this.player.facing * 46, this.player.y - 70 + i * 9);
      }
    }
  }

  private updateUi(time: number): void {
    const config = this.player.config;
    this.uiText.setText(`ラスボス  ${config.name}（${config.kana}）`);
    this.abilityText.setText(this.getSpecialDisplayName());
    this.specialLabelText.setColor(config.uiColor);

    this.uiFx.clear();
    this.uiFx.fillStyle(0x2f3a45, 0.16);
    this.uiFx.fillRoundedRect(22, 22, 380, 78, 16);
    this.uiFx.fillStyle(0xffffff, 0.92);
    this.uiFx.fillRoundedRect(18, 16, 380, 78, 16);
    this.uiFx.lineStyle(3, config.color, 0.9);
    this.uiFx.strokeRoundedRect(18, 16, 380, 78, 16);
    this.uiFx.fillStyle(config.color, 0.92);
    this.uiFx.fillRoundedRect(18, 16, 10, 78, 8);
    this.drawHeartHud(52, 72);

    this.uiFx.fillStyle(0xffffff, 0.9);
    this.uiFx.fillRoundedRect(420, 18, 320, 26, 13);
    this.uiFx.fillStyle(0x2a053d, 0.98);
    this.uiFx.fillRoundedRect(426, 24, 308, 14, 8);
    this.uiFx.fillStyle(0xff4f9d, 0.98);
    this.uiFx.fillRoundedRect(426, 24, 308 * (this.bossHp / this.bossMaxHp), 14, 8);
    this.uiFx.lineStyle(3, 0x8b4de8, 0.95);
    this.uiFx.strokeRoundedRect(420, 18, 320, 26, 13);

    const abilityBoxWidth = Phaser.Math.Clamp(this.abilityText.width + 30, 150, 340);
    this.uiFx.fillStyle(0xffffff, 0.86);
    this.uiFx.fillRoundedRect(18, 119, abilityBoxWidth, 36, 10);
    this.uiFx.lineStyle(3, config.color, 0.95);
    this.uiFx.strokeRoundedRect(18, 119, abilityBoxWidth, 36, 10);

    this.uiFx.fillStyle(0xffffff, 0.8);
    this.uiFx.fillRoundedRect(668, 58, 274, 54, 14);
    characterOrder.forEach((id, index) => {
      const x = 696 + index * 50;
      const isActive = id === this.player.activeId;
      this.uiFx.fillStyle(isActive ? characters[id].color : 0xffffff, isActive ? 0.95 : 0.62);
      this.uiFx.fillCircle(x, 85, isActive ? 23 : 19);
      this.uiFx.lineStyle(isActive ? 4 : 2, isActive ? characters[id].color : 0xd8e0e8, 1);
      this.uiFx.strokeCircle(x, 85, isActive ? 24 : 20);
    });
    this.syncTopIcons();
    this.syncIconRow();
  }

  private drawHeartHud(x: number, y: number): void {
    const spacing = this.maxHp > 5 ? 22 : this.maxHp > 3 ? 25 : 28;
    const scale = this.maxHp > 5 ? 0.78 : this.maxHp > 3 ? 0.86 : 1;
    for (let index = 0; index < this.maxHp; index += 1) {
      const heartX = x + index * spacing;
      const filled = index < this.hp;
      const fillColor = filled ? 0xff4d78 : 0xffffff;
      const strokeColor = filled ? 0xd72f5f : 0xffabc0;

      this.drawHeartShape(heartX + 1, y + 2, 0x2f3a45, 0.14, scale);
      this.drawHeartShape(heartX, y, fillColor, filled ? 0.98 : 0.76, scale);
      this.uiFx.lineStyle(this.maxHp > 5 ? 2 : 3, strokeColor, 0.95);
      this.uiFx.strokeCircle(heartX - 5 * scale, y - 4 * scale, 6 * scale);
      this.uiFx.strokeCircle(heartX + 5 * scale, y - 4 * scale, 6 * scale);
      this.uiFx.strokeTriangle(
        heartX - 12 * scale,
        y - 1 * scale,
        heartX + 12 * scale,
        y - 1 * scale,
        heartX,
        y + 14 * scale,
      );
      if (filled) {
        this.uiFx.fillStyle(0xffffff, 0.52);
        this.uiFx.fillCircle(heartX - 4 * scale, y - 6 * scale, 3 * scale);
      }
    }
  }

  private drawHeartShape(x: number, y: number, color: number, alpha: number, scale = 1): void {
    this.uiFx.fillStyle(color, alpha);
    this.uiFx.fillCircle(x - 5 * scale, y - 4 * scale, 7 * scale);
    this.uiFx.fillCircle(x + 5 * scale, y - 4 * scale, 7 * scale);
    this.uiFx.fillTriangle(x - 13 * scale, y - 1 * scale, x + 13 * scale, y - 1 * scale, x, y + 15 * scale);
  }

  private getSpecialDisplayName(): string {
    const config = this.player.config;
    if (this.player.activeId === "yuri") {
      return `${characters.yuri.dinosaurName}の${config.specialName}`;
    }
    return config.specialName;
  }

  private syncTopIcons(): void {
    while (this.topIconImages.length < characterOrder.length) {
      const index = this.topIconImages.length;
      const id = characterOrder[index];
      const image = this.add
        .image(696 + index * 50, 85, characters[id].iconKey)
        .setDisplaySize(36, 36)
        .setDepth(158)
        .setScrollFactor(0);
      this.topIconImages.push(image);
    }
    this.topIconImages.forEach((image, index) => {
      const id = characterOrder[index];
      const isActive = id === this.player.activeId;
      image.setAlpha(isActive ? 1 : 0.48);
      image.setScale(isActive ? 0.46 : 0.38);
    });
  }

  private syncIconRow(): void {
    this.selectIconImages.forEach((image) => {
      const id = image.getData("characterId") as CharacterId;
      const isActive = id === this.player.activeId;
      image.setAlpha(isActive ? 1 : 0.72);
      image.setScale(isActive ? 1.12 : 1);
      const halo = image.getData("halo") as Phaser.GameObjects.Arc | undefined;
      halo?.setScale(isActive ? 1.12 : 1);
      halo?.setAlpha(isActive ? 1 : 0.72);
    });
  }

  private switchCharacter(direction: -1 | 1): void {
    this.characterIndex = Phaser.Math.Wrap(this.characterIndex + direction, 0, characterOrder.length);
    this.applySelectedCharacter(characterOrder[this.characterIndex]);
  }

  private selectCharacter(id: CharacterId): void {
    this.characterIndex = characterOrder.indexOf(id);
    this.applySelectedCharacter(id);
  }

  private applySelectedCharacter(id: CharacterId): void {
    const wasGrounded = this.player.isGrounded();
    this.player.applyCharacter(id);
    if (wasGrounded) {
      this.player.setVelocityY(0);
    }
    this.spawnRing(this.player.x, this.player.y - 64, characters[id].color);
  }

  private useSpecial(): void {
    const id = this.player.activeId;
    const config = this.player.config;
    const now = this.time.now;
    const readyAt = this.cooldowns[id] ?? 0;
    if (now < readyAt || (id === "inori" && !this.player.isGrounded())) {
      return;
    }

    this.specialPoseUntil = now + 420;
    this.player.playMotion("special");
    switch (id) {
      case "inori":
        this.player.setVelocityY(-940);
        this.cooldowns[id] = now + (config.specialCooldown ?? 0.5) * 1000;
        this.spawnStarBurst(this.player.x, this.player.y - 12, config.color, 14);
        break;
      case "akari":
        this.dashUntil = now + 5000;
        this.cooldowns[id] = now + (config.specialCooldown ?? 1) * 1000;
        break;
      case "shiori":
        this.flightUntil = now + (config.flightDuration ?? 2) * 1000;
        this.cooldowns[id] = now + (config.flightDuration ?? 2) * 1000 + (config.specialCooldown ?? 1.5) * 1000;
        this.spawnRing(this.player.x, this.player.y - 72, config.color);
        break;
      case "yuri":
        this.cooldowns[id] = now + (config.specialCooldown ?? 0.8) * 1000;
        this.summonDinosaur();
        break;
      case "matsuri":
        this.invincibleUntil = now + (config.invincibleDuration ?? 3) * 1000;
        this.cooldowns[id] = now + (config.specialCooldown ?? 10) * 1000;
        this.spawnRing(this.player.x, this.player.y - 48, config.color);
        break;
    }
  }

  private fireOrbs(): void {
    const direction = this.player.x < this.boss.x ? -1 : 1;
    const startX = this.boss.x + direction * 62;
    const startY = this.boss.y - 164;
    const shots = [
      { vx: direction * 250, vy: -145 },
      { vx: direction * 290, vy: 0 },
      { vx: direction * 250, vy: 145 },
    ];
    shots.forEach((shot, index) => {
      const orb = this.projectiles.create(startX, startY + index * 12 - 12, "bossOrb") as Phaser.Physics.Arcade.Sprite;
      orb.setDepth(25);
      orb.setVelocity(shot.vx, shot.vy);
      orb.setCircle(12);
    });
  }

  private fireBeam(): void {
    if (this.beamRect || this.beamCharging || this.hasActiveBossOrbs()) {
      return;
    }

    const direction = this.player.x < this.boss.x ? -1 : 1;
    const y = 396;
    const startX = this.boss.x + direction * 52;
    const width = direction < 0 ? startX : 960 - startX;
    const x = direction < 0 ? startX / 2 : startX + width / 2;
    const chargeX = this.boss.x + direction * 46;
    const chargeY = this.boss.y - 168;
    const warning = this.add.rectangle(x, y, width, 12, 0xff70c7, 0.2).setDepth(24);
    const charge = this.add.circle(chargeX, chargeY, 12, 0xff2e9f, 0.88).setDepth(26);
    charge.setStrokeStyle(4, 0xffffff, 0.86);
    this.beamCharging = true;
    this.boss.setTint(0xffc1ea);
    this.tweens.add({
      targets: [warning, charge],
      alpha: 0.72,
      scaleX: 1.35,
      scaleY: 1.35,
      duration: 150,
      yoyo: true,
      repeat: 4,
      onComplete: () => {
        warning.destroy();
        charge.destroy();
        this.boss.clearTint();
        this.beamCharging = false;
        if (this.isGameOver || this.isEnding || this.hasActiveBossOrbs()) {
          return;
        }
        const originX = direction < 0 ? 1 : 0;
        const beamAura = this.add.rectangle(startX, y, 1, 70, 0x8b4de8, 0.12).setDepth(22).setOrigin(originX, 0.5);
        const beamGlow = this.add.rectangle(startX, y, 1, 48, 0xff4fcb, 0.24).setDepth(23).setOrigin(originX, 0.5);
        this.beamRect = this.add.rectangle(startX, y, 1, 26, 0xff2e9f, 0.12).setDepth(24).setOrigin(originX, 0.5);
        const beamCore = this.add.rectangle(startX, y, 1, 10, 0xffffff, 0.96).setDepth(26).setOrigin(originX, 0.5);
        const topLine = this.add.rectangle(startX, y - 17, 1, 3, 0xffffff, 0.78).setDepth(26).setOrigin(originX, 0.5);
        const bottomLine = this.add.rectangle(startX, y + 17, 1, 3, 0xffffff, 0.78).setDepth(26).setOrigin(originX, 0.5);
        const muzzleGlow = this.add.circle(startX, y, 20, 0xff2e9f, 0.72).setDepth(27);
        muzzleGlow.setStrokeStyle(5, 0xffffff, 0.86);

        this.beamVisuals = [beamAura, beamGlow, beamCore, topLine, bottomLine, muzzleGlow];
        this.beamRect.setOrigin(direction < 0 ? 1 : 0, 0.5);
        this.beamRect.setStrokeStyle(3, 0xffe5fb, 0.82);
        this.beamUntil = this.time.now + 1150;
        this.tweens.add({
          targets: [beamAura, beamGlow, this.beamRect, beamCore, topLine, bottomLine],
          displayWidth: width,
          duration: 620,
          ease: "Quad.easeOut",
        });
        this.tweens.add({
          targets: muzzleGlow,
          scale: 1.32,
          alpha: 0.38,
          duration: 160,
          yoyo: true,
          repeat: 4,
          ease: "Sine.easeInOut",
        });
      },
    });
  }

  private clearBeam(): void {
    this.beamRect?.destroy();
    this.beamRect = undefined;
    this.beamVisuals.forEach((visual) => visual.destroy());
    this.beamVisuals = [];
  }

  private summonDinosaur(): void {
    const config = characters.yuri;
    const direction = this.player.facing < 0 ? -1 : 1;
    const dino = new Dinosaur(
      this,
      this.player.x + direction * 62,
      this.player.y - 8,
      direction,
      config.dinosaurSpeed ?? 360,
      (config.dinosaurLifetime ?? 2.5) * 1000,
    );
    this.dinosaurs.add(dino);
    this.spawnStarBurst(dino.x, dino.y - 38, config.color, 8);
  }

  private damageBoss(amount: number, x: number, y: number): void {
    const now = this.time.now;
    if (now < this.bossInvulnerableUntil || this.isEnding || this.isMatsuriInvincible(now)) {
      return;
    }

    this.bossInvulnerableUntil = now + 360;
    this.bossHp = Math.max(0, this.bossHp - amount);
    this.spawnStarBurst(x, y, 0xff70c7, amount === 1 ? 5 : 12);
    this.boss.setTint(0xffb5e6);
    this.time.delayedCall(130, () => this.boss.clearTint());
    this.cameras.main.shake(80, amount === 1 ? 0.003 : 0.007);
    if (this.bossHp <= 0) {
      this.clearBoss();
    }
  }

  private registerBossStomp(time: number): void {
    if (this.isEnding || this.bossHp <= 0 || this.bossEvadeTargetX !== undefined) {
      return;
    }

    this.bossStompChain += 1;
    if (this.bossStompChain < 2) {
      return;
    }

    const wallX =
      this.boss.x < 450
        ? 820
        : this.boss.x > 510
          ? 190
          : this.bossEvadeDirection >= 0
            ? 820
            : 190;

    this.bossEvadeTargetX = wallX;
    this.bossEvadeDirection = wallX > this.boss.x ? 1 : -1;
    this.bossInvulnerableUntil = time + 900;
    this.bossTouchSafeUntil = time + 900;
    this.clearBeam();
    this.spawnRing(this.boss.x, this.boss.y - 150, 0xff70c7);
  }

  private defeatPlayer(source?: Phaser.GameObjects.GameObject): void {
    this.takeDamage(source);
  }

  private takeDamage(source?: Phaser.GameObjects.GameObject, forceRespawn = false): void {
    const now = this.time.now;
    if (
      now < this.damageLockUntil ||
      this.isMatsuriInvincible(now) ||
      this.isAkariDashActive(now) ||
      this.isGameOver ||
      this.isEnding
    ) {
      return;
    }

    source?.destroy();
    this.hp -= 1;
    this.damageLockUntil = now + 1300;
    this.cameras.main.shake(120, 0.006);

    if (this.hp <= 0) {
      this.hp = 0;
      this.showRetryOverlay();
      return;
    }

    this.player.setTint(0xffb8c8);
    const knockback = this.player.x < this.boss.x ? -290 : 290;
    this.player.setVelocity(forceRespawn ? 0 : knockback, forceRespawn ? 0 : -260);
    if (forceRespawn) {
      this.player.setPosition(this.player.x < 480 ? 150 : 810, 486);
    }
    this.time.delayedCall(520, () => this.player.clearTint());
  }

  private isMatsuriInvincible(time: number): boolean {
    return this.player.activeId === "matsuri" && time < this.invincibleUntil;
  }

  private isAkariDashActive(time: number): boolean {
    return this.player.activeId === "akari" && time < this.dashUntil;
  }

  private getBossBodyRect(): Phaser.Geom.Rectangle {
    return new Phaser.Geom.Rectangle(this.boss.x - 58, this.boss.y - 208, 116, 204);
  }

  private getBossHeadRect(): Phaser.Geom.Rectangle {
    return new Phaser.Geom.Rectangle(this.boss.x - 46, this.boss.y - 238, 92, 70);
  }

  private showRetryOverlay(): void {
    if (this.retryLayer || this.isEnding) {
      return;
    }

    this.isGameOver = true;
    this.player.setVelocity(0, 0);
    this.player.setTint(0xffc4c4);
    this.physics.pause();
    this.cameras.main.shake(160, 0.008);

    const backdrop = this.add.rectangle(480, 270, 960, 540, 0x260a35, 0.42).setScrollFactor(0);
    const panel = this.add
      .rectangle(480, 270, 390, 210, 0xffffff, 0.94)
      .setScrollFactor(0)
      .setStrokeStyle(4, 0xff70c7, 1);
    const title = this.add
      .text(480, 220, "ラスボスにやられた！", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "28px",
        fontStyle: "900",
        color: "#4a164d",
      })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const help = this.add
      .text(480, 260, "踏みつけかチビティラで反撃", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "16px",
        color: "#516070",
      })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const retryButton = this.add
      .circle(480, 330, 48, 0x8b4de8, 0.94)
      .setStrokeStyle(5, 0xffffff, 1)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true });
    const retryText = this.add
      .text(480, 330, "リトライ", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "18px",
        fontStyle: "900",
        color: "#ffffff",
      })
      .setOrigin(0.5)
      .setScrollFactor(0);

    this.retryLayer = this.add.container(0, 0, [backdrop, panel, title, help, retryButton, retryText]).setDepth(330).setScrollFactor(0);
    retryButton.on("pointerdown", () => this.restartBoss());
    this.input.keyboard?.once("keydown-SPACE", () => this.restartBoss());
  }

  private restartBoss(): void {
    this.scene.restart({
      score: this.score,
      stars: this.starsCollected,
      difficulty: this.difficultyId,
    });
  }

  private clearBoss(): void {
    if (this.isEnding) {
      return;
    }

    this.isEnding = true;
    this.player.setVelocity(0, 0);
    this.projectiles.clear(true, true);
    this.clearBeam();
    this.spawnStarBurst(this.boss.x, this.boss.y - 210, 0xffd84d, 24);
    this.cameras.main.fadeOut(620, 255, 255, 255);
    this.time.delayedCall(650, () => {
      this.scene.start("ClearScene", {
        score: this.score + 500,
        stars: this.starsCollected,
        round: 5,
        totalRounds: 5,
        bossCleared: true,
        difficulty: this.difficultyId,
      });
    });
  }

  private spawnStarBurst(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const star = this.add.star(x, y, 5, 3, 9, color, 0.95).setDepth(40);
      this.tweens.add({
        targets: star,
        x: x + Math.cos(angle) * Phaser.Math.Between(18, 52),
        y: y + Math.sin(angle) * Phaser.Math.Between(18, 52),
        alpha: 0,
        scale: 0.3,
        duration: 520,
        ease: "Quad.easeOut",
        onComplete: () => star.destroy(),
      });
    }
  }

  private spawnRing(x: number, y: number, color: number): void {
    const ring = this.add.circle(x, y, 8).setStrokeStyle(4, color, 0.75).setDepth(38);
    this.tweens.add({
      targets: ring,
      radius: 62,
      alpha: 0,
      duration: 420,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
  }
}
