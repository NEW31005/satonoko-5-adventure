import Phaser from "phaser";
import { characterOrder, characters, CharacterId } from "../data/characters";
import { levelData, RectSpec, roundCount, RoundData, rounds } from "../data/levelData";
import { Dinosaur } from "../objects/Dinosaur";
import { Enemy } from "../objects/Enemy";
import { Player } from "../objects/Player";

type ControlKeys = {
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  up: Phaser.Input.Keyboard.Key;
  space: Phaser.Input.Keyboard.Key;
  x: Phaser.Input.Keyboard.Key;
  q: Phaser.Input.Keyboard.Key;
  e: Phaser.Input.Keyboard.Key;
  r: Phaser.Input.Keyboard.Key;
};

type VirtualControls = {
  left: boolean;
  right: boolean;
  jumpHeld: boolean;
  jumpQueued: boolean;
};

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private controls!: ControlKeys;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private stars!: Phaser.Physics.Arcade.StaticGroup;
  private hearts!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private rocks!: Phaser.Physics.Arcade.StaticGroup;
  private dashWalls!: Phaser.Physics.Arcade.StaticGroup;
  private enemies!: Phaser.GameObjects.Group;
  private dinosaurs!: Phaser.Physics.Arcade.Group;
  private goalZone!: Phaser.GameObjects.Zone;
  private worldFx!: Phaser.GameObjects.Graphics;
  private uiFx!: Phaser.GameObjects.Graphics;
  private uiText!: Phaser.GameObjects.Text;
  private specialLabelText!: Phaser.GameObjects.Text;
  private abilityText!: Phaser.GameObjects.Text;
  private topIconImages: Phaser.GameObjects.Image[] = [];
  private selectIconImages: Phaser.GameObjects.Image[] = [];
  private level: RoundData = levelData;
  private currentRoundIndex = 0;
  private roundStartScore = 0;
  private roundStartStars = 0;
  private characterIndex = 0;
  private score = 0;
  private starsCollected = 0;
  private hp = 3;
  private checkpoint = { ...levelData.checkpoint };
  private damageLockUntil = 0;
  private dashUntil = 0;
  private flightUntil = 0;
  private invincibleUntil = 0;
  private hazardDashFxUntil = 0;
  private cooldowns: Partial<Record<CharacterId, number>> = {};
  private isClearing = false;
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
    super("GameScene");
  }

  init(data?: { roundIndex?: number; score?: number; stars?: number }): void {
    this.currentRoundIndex = Phaser.Math.Clamp(data?.roundIndex ?? 0, 0, roundCount - 1);
    this.level = rounds[this.currentRoundIndex] ?? rounds[0];
    this.roundStartScore = data?.score ?? 0;
    this.roundStartStars = data?.stars ?? 0;
  }

  create(): void {
    this.characterIndex = 0;
    this.score = this.roundStartScore;
    this.starsCollected = this.roundStartStars;
    this.hp = 3;
    this.checkpoint = { ...this.level.checkpoint };
    this.damageLockUntil = 0;
    this.dashUntil = 0;
    this.flightUntil = 0;
    this.invincibleUntil = 0;
    this.hazardDashFxUntil = 0;
    this.cooldowns = {};
    this.isClearing = false;
    this.isGameOver = false;
    this.retryLayer = undefined;
    this.specialPoseUntil = 0;
    this.virtualControls = {
      left: false,
      right: false,
      jumpHeld: false,
      jumpQueued: false,
    };

    this.physics.world.setBounds(0, 0, this.level.worldWidth, this.level.worldHeight);
    this.cameras.main.setBounds(0, 0, this.level.worldWidth, 540);
    this.createGeneratedTextures();
    this.createSpriteAnimations();
    this.addBackground();

    this.platforms = this.physics.add.staticGroup();
    this.stars = this.physics.add.staticGroup();
    this.hearts = this.physics.add.staticGroup();
    this.hazards = this.physics.add.staticGroup();
    this.rocks = this.physics.add.staticGroup();
    this.dashWalls = this.physics.add.staticGroup();
    this.enemies = this.add.group();
    this.dinosaurs = this.physics.add.group();
    this.worldFx = this.add.graphics().setDepth(14);

    this.createPlatforms();
    this.createCollectibles();
    this.createHazards();
    this.createLocks();
    this.createEnemies();
    this.createGoal();

    this.player = new Player(this, this.level.start.x, this.level.start.y);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12, 0, 70);

    this.physics.add.collider(this.player, this.platforms);
    this.physics.add.collider(this.enemies, this.platforms);
    this.physics.add.collider(this.player, this.rocks);
    this.physics.add.collider(this.player, this.dashWalls);

    this.physics.add.overlap(this.player, this.stars, (_, star) => {
      this.collectStar(star as Phaser.GameObjects.GameObject);
    });
    this.physics.add.overlap(this.player, this.hearts, (_, heart) => {
      this.collectHeart(heart as Phaser.GameObjects.GameObject);
    });
    this.physics.add.overlap(this.player, this.goalZone, () => {
      this.clearStage();
    });
    this.physics.add.overlap(this.player, this.hazards, () => {
      if (this.isAkariDashActive()) {
        if (this.time.now > this.hazardDashFxUntil) {
          this.hazardDashFxUntil = this.time.now + 240;
          this.spawnSpeedFlash();
        }
        return;
      }
      this.takeDamage();
    });
    this.physics.add.overlap(this.player, this.enemies, (_, enemy) => {
      this.touchEnemy(enemy as Enemy);
    });
    this.physics.add.overlap(this.dinosaurs, this.rocks, (dino, rock) => {
      if (!this.canDinosaurAffect(dino as Dinosaur, rock as Phaser.GameObjects.GameObject)) {
        return;
      }
      this.breakRock(rock as Phaser.GameObjects.GameObject);
      (dino as Dinosaur).destroy();
    });
    this.physics.add.overlap(this.dinosaurs, this.enemies, (dino, enemy) => {
      if (!this.canDinosaurAffect(dino as Dinosaur, enemy as Phaser.GameObjects.GameObject)) {
        return;
      }
      this.popEnemy(enemy as Enemy);
      (dino as Dinosaur).destroy();
    });
    this.physics.add.overlap(this.dinosaurs, this.hazards, (dino, hazard) => {
      if (!this.canDinosaurAffect(dino as Dinosaur, hazard as Phaser.GameObjects.GameObject)) {
        return;
      }
      this.breakHazard(hazard as Phaser.GameObjects.GameObject);
    });

    this.controls = this.input.keyboard!.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
      up: Phaser.Input.Keyboard.KeyCodes.UP,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      x: Phaser.Input.Keyboard.KeyCodes.X,
      q: Phaser.Input.Keyboard.KeyCodes.Q,
      e: Phaser.Input.Keyboard.KeyCodes.E,
      r: Phaser.Input.Keyboard.KeyCodes.R,
    }) as ControlKeys;

    this.createUi();
    this.createTouchControls();
    this.showRoundIntro();
  }

  update(time: number): void {
    if (this.isClearing) {
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.r)) {
      this.restartRound();
      return;
    }

    if (this.isGameOver) {
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.q)) {
      this.switchCharacter(-1);
    } else if (Phaser.Input.Keyboard.JustDown(this.controls.e)) {
      this.switchCharacter(1);
    }

    if (Phaser.Input.Keyboard.JustDown(this.controls.x)) {
      this.useSpecial();
    }

    this.updateMovement(time);
    this.updateFlight(time);
    this.updateCheckpoint();
    this.updateActors(time);
    this.updateEffects(time);
    this.updateUi(time);

    if (this.player.y > 610) {
      this.takeDamage(true);
    }
  }

  private createGeneratedTextures(): void {
    if (this.textures.exists("star")) {
      return;
    }

    const star = this.add.graphics();
    star.fillStyle(0xffd44d, 1);
    star.lineStyle(3, 0xffffff, 1);
    const points: Phaser.Math.Vector2[] = [];
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 === 0 ? 16 : 7;
      points.push(new Phaser.Math.Vector2(18 + Math.cos(angle) * radius, 18 + Math.sin(angle) * radius));
    }
    star.fillPoints(points, true);
    star.strokePoints(points, true);
    star.generateTexture("star", 36, 36);
    star.destroy();

    const heart = this.add.graphics();
    heart.fillStyle(0xff5d80, 1);
    heart.fillCircle(13, 13, 8);
    heart.fillCircle(23, 13, 8);
    heart.fillTriangle(6, 18, 30, 18, 18, 33);
    heart.lineStyle(3, 0xffffff, 1);
    heart.strokeCircle(13, 13, 8);
    heart.strokeCircle(23, 13, 8);
    heart.generateTexture("heart", 36, 36);
    heart.destroy();

    const slime = this.add.graphics();
    slime.fillStyle(0x8bdc83, 1);
    slime.fillEllipse(34, 34, 58, 38);
    slime.fillStyle(0xffffff, 1);
    slime.fillCircle(24, 27, 6);
    slime.fillCircle(43, 27, 6);
    slime.fillStyle(0x243029, 1);
    slime.fillCircle(25, 28, 2);
    slime.fillCircle(42, 28, 2);
    slime.lineStyle(4, 0x4da85c, 1);
    slime.strokeEllipse(34, 34, 58, 38);
    slime.generateTexture("slime", 68, 58);
    slime.destroy();
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
    this.ensureAnimation("turtle-enemy-walk", "turtleEnemySheet", [0, 1, 2, 3, 4, 5], 7, -1);
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
    const sky = this.add.graphics().setScrollFactor(0);
    sky.fillGradientStyle(0xe8f9ff, 0xe8f9ff, 0xfff7de, 0xfff7de, 1);
    sky.fillRect(0, 0, 960, 540);

    const far = this.add.graphics().setScrollFactor(0.12).setDepth(-10);
    far.fillStyle(0xc8ecb3, 1);
    far.fillEllipse(500, 520, 760, 240);
    far.fillEllipse(1250, 510, 690, 210);
    far.fillEllipse(2100, 525, 820, 230);
    far.fillStyle(0xffe59a, 0.7);
    far.fillCircle(830, 86, 42);

    for (const cloud of [
      { x: 260, y: 105, scale: 1 },
      { x: 930, y: 90, scale: 0.78 },
      { x: 1650, y: 122, scale: 1.12 },
      { x: 2850, y: 92, scale: 0.9 },
      { x: 3800, y: 135, scale: 0.82 },
    ]) {
      this.drawCloud(cloud.x, cloud.y, cloud.scale);
    }
  }

  private drawCloud(x: number, y: number, scale: number): void {
    const cloud = this.add.graphics().setScrollFactor(0.25).setDepth(-8);
    cloud.fillStyle(0xffffff, 0.86);
    cloud.fillEllipse(x, y, 130 * scale, 42 * scale);
    cloud.fillCircle(x - 42 * scale, y - 8 * scale, 23 * scale);
    cloud.fillCircle(x + 2 * scale, y - 22 * scale, 31 * scale);
    cloud.fillCircle(x + 48 * scale, y - 7 * scale, 25 * scale);
  }

  private createPlatforms(): void {
    this.level.platforms.forEach((platform) => this.addPlatform(platform));
  }

  private addPlatform({ x, y, width, height }: RectSpec): void {
    const top = this.add.rectangle(x + width / 2, y + height / 2, width, height, 0x8ecb58).setDepth(1);
    top.setStrokeStyle(2, 0x5f9f3d, 1);
    this.physics.add.existing(top, true);
    this.platforms.add(top);

    const grass = this.add.rectangle(x + width / 2, y + 5, width, 10, 0x58b866).setDepth(2);
    grass.setStrokeStyle(0);
  }

  private createCollectibles(): void {
    this.level.stars.forEach(({ x, y }) => {
      const star = this.stars.create(x, y, "star") as Phaser.Physics.Arcade.Sprite;
      star.setDisplaySize(30, 30);
      star.setDepth(9);
      star.refreshBody();
      this.tweens.add({
        targets: star,
        y: y - 8,
        duration: 800,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    });

    this.level.hearts.forEach(({ x, y }) => {
      const heart = this.hearts.create(x, y, "heart") as Phaser.Physics.Arcade.Sprite;
      heart.setDisplaySize(32, 32);
      heart.setDepth(9);
      heart.refreshBody();
    });
  }

  private createHazards(): void {
    this.level.spikes.forEach((spike) => {
      const zone = this.add.zone(spike.x + spike.width / 2, spike.y + spike.height / 2, spike.width, spike.height);
      this.physics.add.existing(zone, true);
      this.hazards.add(zone);

      const count = Math.floor(spike.width / 28);
      const visuals: Phaser.GameObjects.Triangle[] = [];
      for (let i = 0; i < count; i += 1) {
        const triangle = this.add
          .triangle(spike.x + 14 + i * 28, spike.y + spike.height, 0, 28, 14, 0, 28, 28, 0xff7b67)
          .setStrokeStyle(2, 0xffffff, 0.85)
          .setDepth(8);
        visuals.push(triangle);
      }
      zone.setData("visuals", visuals);
    });
  }

  private createLocks(): void {
    this.level.dashWalls.forEach((wall) => {
      const block = this.add.rectangle(wall.x + wall.width / 2, wall.y + wall.height / 2, wall.width, wall.height, 0xb282ff);
      block.setStrokeStyle(4, 0xffffff, 1);
      block.setData("kind", "dashWall");
      this.physics.add.existing(block, true);
      this.dashWalls.add(block);
    });

    this.level.rocks.forEach((rock) => {
      const block = this.add.rectangle(rock.x + rock.width / 2, rock.y + rock.height / 2, rock.width, rock.height, 0x9d7150);
      block.setStrokeStyle(4, 0x6d472f, 1);
      block.setData("kind", "rock");
      this.physics.add.existing(block, true);
      this.rocks.add(block);

      for (let i = 0; i < 5; i += 1) {
        this.add.circle(rock.x + 18 + i * 16, rock.y + 18 + (i % 2) * 28, 4, 0x7e5439, 0.75).setDepth(4);
      }
    });
  }

  private createEnemies(): void {
    this.level.enemies.forEach((enemy) => {
      this.enemies.add(new Enemy(this, enemy.x, enemy.y, enemy.minX, enemy.maxX));
    });
  }

  private createGoal(): void {
    const { x, y, width, height } = this.level.goal;
    const pole = this.add.rectangle(x + width / 2, y + height / 2, 10, height, 0x6b4b2b).setDepth(4);
    const flag = this.add.triangle(x + 42, y + 34, 0, 0, 74, 24, 0, 48, 0xffd84d).setDepth(5);
    flag.setStrokeStyle(3, 0xffffff, 1);
    this.add.star(x + 72, y + 35, 5, 6, 14, 0xffffff).setDepth(6);

    this.goalZone = this.add.zone(x + width / 2, y + height / 2, width + 34, height);
    this.physics.add.existing(this.goalZone, true);
    pole.setData("goal", true);
  }

  private createUi(): void {
    this.uiFx = this.add.graphics().setDepth(100).setScrollFactor(0);
    this.topIconImages = [];
    this.selectIconImages = [];
    this.uiText = this.add
      .text(18, 16, "", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "18px",
        fontStyle: "700",
        color: "#32261f",
        backgroundColor: "rgba(255,255,255,0.82)",
        padding: { x: 14, y: 10 },
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.abilityText = this.add
      .text(30, 111, "", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "15px",
        fontStyle: "700",
        color: "#32261f",
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.specialLabelText = this.add
      .text(22, 87, "SPECIAL", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "12px",
        fontStyle: "900",
        color: "#4b5360",
      })
      .setDepth(101)
      .setScrollFactor(0);

    this.updateUi(this.time.now);
  }

  private createTouchControls(): void {
    this.input.addPointer(4);

    this.createCharacterIconButtons();

    this.addHoldButton(86, 484, "JUMP", 0xffd84d, () => {
      this.virtualControls.jumpHeld = true;
      this.virtualControls.jumpQueued = true;
    }, () => {
      this.virtualControls.jumpHeld = false;
    }, 78, 78, "#3a2c13", "15px");

    this.addTapButton(206, 484, "SPECIAL", 0x9b5cff, 0xffffff, () => {
      this.useSpecial();
    }, 78, "12px");

    this.addMovePad(820, 488);
  }

  private showRoundIntro(): void {
    const text = this.add
      .text(480, 164, `ラウンド ${this.level.round}\n${this.level.title}`, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "34px",
        fontStyle: "900",
        color: "#4a2a10",
        align: "center",
        stroke: "#ffffff",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(315)
      .setScrollFactor(0);

    this.tweens.add({
      targets: text,
      y: 136,
      alpha: 0,
      delay: 900,
      duration: 650,
      ease: "Quad.easeIn",
      onComplete: () => text.destroy(),
    });
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
    this.add
      .circle(x - 12, y - 14, 10, 0xffffff, 0.2)
      .setDepth(155)
      .setScrollFactor(0);
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
    this.add
      .circle(x - size * 0.13, y - size * 0.15, size * 0.11, 0xffffff, 0.22)
      .setDepth(156)
      .setScrollFactor(0);
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
      if (this.player.activeId === "inori") {
        this.spawnStarBurst(this.player.x, this.player.y - 8, 0xffd84d, 6);
      }
    }

    if (this.player.x < 48) {
      this.player.setX(48);
      if (body.velocity.x < 0) {
        this.player.setVelocityX(0);
      }
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

  private switchCharacter(direction: -1 | 1): void {
    this.characterIndex = Phaser.Math.Wrap(this.characterIndex + direction, 0, characterOrder.length);
    const id = characterOrder[this.characterIndex];
    this.applySelectedCharacter(id);
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

    if (now < readyAt) {
      return;
    }

    if (id === "inori" && !this.player.isGrounded()) {
      return;
    }

    this.specialPoseUntil = now + 420;
    this.player.playMotion("special");

    switch (id) {
      case "inori": {
        this.player.setVelocityY(-940);
        this.cooldowns[id] = now + (config.specialCooldown ?? 0.5) * 1000;
        this.spawnStarBurst(this.player.x, this.player.y - 12, config.color, 14);
        break;
      }
      case "akari": {
        this.dashUntil = now + 5000;
        this.cooldowns[id] = now + (config.specialCooldown ?? 1) * 1000;
        this.spawnSpeedFlash();
        break;
      }
      case "shiori": {
        this.flightUntil = now + (config.flightDuration ?? 2) * 1000;
        this.cooldowns[id] = now + (config.flightDuration ?? 2) * 1000 + (config.specialCooldown ?? 1.5) * 1000;
        this.spawnRing(this.player.x, this.player.y - 72, config.color);
        break;
      }
      case "yuri": {
        this.cooldowns[id] = now + (config.specialCooldown ?? 0.8) * 1000;
        this.summonDinosaur();
        break;
      }
      case "matsuri": {
        this.invincibleUntil = now + (config.invincibleDuration ?? 3) * 1000;
        this.cooldowns[id] = now + (config.specialCooldown ?? 10) * 1000;
        this.spawnRing(this.player.x, this.player.y - 48, config.color);
        break;
      }
    }
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
    const body = dino.body as Phaser.Physics.Arcade.Body;
    body.setVelocityX((config.dinosaurSpeed ?? 760) * direction);
    body.setVelocityY(0);
    this.spawnStarBurst(dino.x, dino.y - 38, config.color, 8);
    this.spawnDinosaurChargeTrail(dino.x, dino.y - 38, direction);
  }

  private updateActors(time: number): void {
    this.enemies.getChildren().forEach((enemy) => {
      (enemy as Enemy).update();
    });
    this.dinosaurs.getChildren().forEach((dino) => {
      const dinosaur = dino as Dinosaur;
      dinosaur.update(time);
      if (dinosaur.active && !this.isObjectInCameraView(dinosaur)) {
        dinosaur.destroy();
      }
    });
  }

  private canDinosaurAffect(dinosaur: Dinosaur, target: Phaser.GameObjects.GameObject): boolean {
    return this.isObjectInCameraView(dinosaur) && this.isObjectInCameraView(target);
  }

  private isObjectInCameraView(object: Phaser.GameObjects.GameObject): boolean {
    const view = this.cameras.main.worldView;
    const item = object as Phaser.GameObjects.GameObject & {
      x?: number;
      y?: number;
      displayWidth?: number;
      displayHeight?: number;
      width?: number;
      height?: number;
    };
    const x = item.x ?? 0;
    const y = item.y ?? 0;
    const halfWidth = (item.displayWidth ?? item.width ?? 0) / 2;
    const halfHeight = (item.displayHeight ?? item.height ?? 0) / 2;

    return (
      x + halfWidth >= view.left &&
      x - halfWidth <= view.right &&
      y + halfHeight >= view.top &&
      y - halfHeight <= view.bottom
    );
  }

  private updateCheckpoint(): void {
    this.level.checkpoints.forEach((checkpoint) => {
      if (this.player.x > checkpoint.x) {
        this.checkpoint = { ...checkpoint };
      }
    });
  }

  private restartRound(): void {
    this.scene.restart({
      roundIndex: this.currentRoundIndex,
      score: this.roundStartScore,
      stars: this.roundStartStars,
    });
  }

  private startNextRound(): void {
    const nextRoundIndex = this.currentRoundIndex + 1;
    if (nextRoundIndex >= roundCount) {
      this.scene.start("BossScene", {
        score: this.score,
        stars: this.starsCollected,
      });
      return;
    }

    this.scene.restart({
      roundIndex: nextRoundIndex,
      score: this.score,
      stars: this.starsCollected,
    });
  }

  private updateEffects(time: number): void {
    this.worldFx.clear();

    if (this.player.activeId === "matsuri" && time < this.invincibleUntil) {
      this.worldFx.lineStyle(4, 0xffd700, 0.7);
      this.worldFx.fillStyle(0xffeaa0, 0.12);
      this.worldFx.fillCircle(this.player.x, this.player.y - 52, 62);
      this.worldFx.strokeCircle(this.player.x, this.player.y - 52, 62 + Math.sin(time / 90) * 3);
    }

    if (this.player.activeId === "shiori" && time < this.flightUntil) {
      this.worldFx.lineStyle(3, 0x78d8ff, 0.5);
      this.worldFx.beginPath();
      this.worldFx.arc(this.player.x - 28, this.player.y - 76, 34, -0.9, 1.2, true);
      this.worldFx.arc(this.player.x + 28, this.player.y - 76, 34, 1.9, 4.1, true);
      this.worldFx.strokePath();
    }

    if (this.player.activeId === "akari" && time < this.dashUntil) {
      this.worldFx.lineStyle(4, characters.akari.color, 0.5);
      for (let i = 0; i < 5; i += 1) {
        const offset = i * 18;
        const x = this.player.x - this.player.facing * (42 + offset);
        this.worldFx.lineBetween(x, this.player.y - 70 + i * 9, x - this.player.facing * 46, this.player.y - 70 + i * 9);
      }
    }
  }

  private updateUi(time: number): void {
    const config = this.player.config;
    const hpText = "♥".repeat(this.hp) + "♡".repeat(Math.max(0, 3 - this.hp));
    this.uiText.setText(`R${this.level.round}/${roundCount} ${config.name}（${config.kana}）  ${hpText}  スコア ${this.score}`);

    this.abilityText.setText(this.getSpecialDisplayName());
    this.specialLabelText.setColor(config.uiColor);

    this.uiFx.clear();
    const abilityBoxWidth = Phaser.Math.Clamp(this.abilityText.width + 24, 190, 360);
    this.uiFx.fillStyle(0xffffff, 0.86);
    this.uiFx.fillRoundedRect(18, 101, abilityBoxWidth, 36, 10);
    this.uiFx.lineStyle(3, config.color, 0.95);
    this.uiFx.strokeRoundedRect(18, 101, abilityBoxWidth, 36, 10);

    this.uiFx.fillStyle(0xffffff, 0.8);
    this.uiFx.fillRoundedRect(668, 12, 274, 54, 14);
    characterOrder.forEach((id, index) => {
      const x = 696 + index * 50;
      const isActive = id === this.player.activeId;
      this.uiFx.fillStyle(isActive ? characters[id].color : 0xffffff, isActive ? 0.95 : 0.62);
      this.uiFx.fillCircle(x, 39, isActive ? 23 : 19);
      this.uiFx.lineStyle(isActive ? 4 : 2, isActive ? characters[id].color : 0xd8e0e8, 1);
      this.uiFx.strokeCircle(x, 39, isActive ? 24 : 20);
    });

    this.syncIconRow();
    this.syncTopIcons();

    const activeRatio = this.getAbilityRatio(time);
    this.uiFx.fillStyle(0xffffff, 0.82);
    this.uiFx.fillRoundedRect(736, 72, 206, 20, 10);
    this.uiFx.fillStyle(config.color, 0.9);
    this.uiFx.fillRoundedRect(740, 76, 198 * activeRatio, 12, 8);
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
        .image(696 + index * 50, 39, characters[id].iconKey)
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

  private getAbilityRatio(time: number): number {
    const id = this.player.activeId;
    if (id === "shiori" && time < this.flightUntil) {
      return Phaser.Math.Clamp((this.flightUntil - time) / ((characters.shiori.flightDuration ?? 2) * 1000), 0, 1);
    }
    if (id === "matsuri" && time < this.invincibleUntil) {
      return Phaser.Math.Clamp((this.invincibleUntil - time) / ((characters.matsuri.invincibleDuration ?? 3) * 1000), 0, 1);
    }
    const readyAt = this.cooldowns[id] ?? 0;
    if (time >= readyAt) {
      return 1;
    }
    const cooldownSeconds = characters[id].specialCooldown ?? 1;
    return Phaser.Math.Clamp(1 - (readyAt - time) / (cooldownSeconds * 1000), 0, 1);
  }

  private collectStar(star: Phaser.GameObjects.GameObject): void {
    const sprite = star as Phaser.GameObjects.Sprite;
    this.score += 10;
    this.starsCollected += 1;
    this.spawnStarBurst(sprite.x, sprite.y, 0xffd84d, 5);
    sprite.destroy();
  }

  private collectHeart(heart: Phaser.GameObjects.GameObject): void {
    const sprite = heart as Phaser.GameObjects.Sprite;
    this.hp = Math.min(3, this.hp + 1);
    this.spawnRing(sprite.x, sprite.y, 0xff5d80);
    sprite.destroy();
  }

  private touchEnemy(enemy: Enemy): void {
    if (!enemy.active || this.isGameOver || this.isClearing) {
      return;
    }

    if (this.isEnemyStomp(enemy)) {
      this.popEnemy(enemy);
      this.player.setVelocityY(-390);
      this.spawnStarBurst(this.player.x, this.player.y - 42, 0xffd84d, 5);
      return;
    }

    if (this.time.now < this.invincibleUntil) {
      return;
    }

    this.takeDamage();
  }

  private isEnemyStomp(enemy: Enemy): boolean {
    const playerBody = this.player.body as Phaser.Physics.Arcade.Body;
    const enemyBody = enemy.body as Phaser.Physics.Arcade.Body;
    const fallingFromAbove = playerBody.velocity.y > 130;
    const feetNearEnemyTop = playerBody.bottom <= enemyBody.top + 24;
    const centeredOverEnemy = Math.abs(this.player.x - enemy.x) <= enemy.displayWidth * 0.36;
    return fallingFromAbove && feetNearEnemyTop && centeredOverEnemy;
  }

  private isAkariDashActive(time = this.time.now): boolean {
    return this.player.activeId === "akari" && time < this.dashUntil;
  }

  private takeDamage(forceRespawn = false): void {
    const now = this.time.now;
    if (this.isGameOver || this.isClearing) {
      return;
    }

    if (!forceRespawn && (now < this.damageLockUntil || now < this.invincibleUntil)) {
      return;
    }

    this.hp -= 1;
    this.damageLockUntil = now + 1300;
    this.cameras.main.shake(120, 0.006);

    if (this.hp <= 0) {
      this.hp = 0;
      this.showRetryOverlay();
      return;
    }

    this.player.setTint(0xff9b9b);
    this.player.setVelocity(0, 0);
    this.player.setPosition(this.checkpoint.x, this.checkpoint.y);
    this.time.delayedCall(500, () => this.player.clearTint());
  }

  private showRetryOverlay(): void {
    if (this.retryLayer) {
      return;
    }

    this.isGameOver = true;
    this.player.setVelocity(0, 0);
    this.player.setTint(0xffc4c4);
    this.physics.pause();
    this.cameras.main.shake(160, 0.008);

    const backdrop = this.add
      .rectangle(480, 270, 960, 540, 0x26364a, 0.34)
      .setScrollFactor(0);
    const panel = this.add
      .rectangle(480, 270, 370, 210, 0xffffff, 0.94)
      .setScrollFactor(0)
      .setStrokeStyle(4, 0xffd84d, 1);
    const title = this.add
      .text(480, 220, "もういちどチャレンジ！", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "28px",
        fontStyle: "900",
        color: "#4a2a10",
      })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const help = this.add
      .text(480, 260, "ボタンをタップしてリトライ", {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "16px",
        color: "#516070",
      })
      .setOrigin(0.5)
      .setScrollFactor(0);
    const retryButton = this.add
      .circle(480, 330, 48, 0x2f7ac8, 0.94)
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

    this.retryLayer = this.add
      .container(0, 0, [backdrop, panel, title, help, retryButton, retryText])
      .setDepth(320)
      .setScrollFactor(0);

    retryButton.on("pointerdown", () => {
      this.restartRound();
    });

    this.input.keyboard?.once("keydown-SPACE", () => {
      this.restartRound();
    });
  }

  private breakRock(rock: Phaser.GameObjects.GameObject): void {
    const rect = rock as Phaser.GameObjects.Rectangle;
    this.spawnStarBurst(rect.x, rect.y, 0xff7a3c, 9);
    rect.destroy();
  }

  private breakHazard(hazard: Phaser.GameObjects.GameObject): void {
    const zone = hazard as Phaser.GameObjects.Zone;
    const visuals = zone.getData("visuals") as Phaser.GameObjects.Triangle[] | undefined;
    this.spawnStarBurst(zone.x, zone.y, 0xff7b67, 10);
    visuals?.forEach((visual) => visual.destroy());
    zone.destroy();
  }

  private breakDashWall(wall: Phaser.GameObjects.GameObject): void {
    const rect = wall as Phaser.GameObjects.Rectangle;
    this.spawnSpeedFlash();
    rect.destroy();
  }

  private popEnemy(enemy: Enemy): void {
    this.spawnStarBurst(enemy.x, enemy.y - 48, 0x78b957, 7);
    enemy.destroy();
    this.score += 20;
  }

  private clearStage(): void {
    if (this.isClearing) {
      return;
    }

    this.isClearing = true;
    this.player.setVelocity(0, 0);
    const roundText = this.add
      .text(480, 232, this.currentRoundIndex + 1 >= roundCount ? "ぜんぶクリア！" : `ラウンド${this.level.round}クリア！`, {
        fontFamily: '"Yu Gothic", "Meiryo", sans-serif',
        fontSize: "36px",
        fontStyle: "900",
        color: "#4a2a10",
        stroke: "#ffffff",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(330)
      .setScrollFactor(0);
    this.cameras.main.fadeOut(450, 255, 255, 255);
    this.time.delayedCall(460, () => {
      roundText.destroy();
      this.startNextRound();
    });
  }

  private spawnStarBurst(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const star = this.add.star(x, y, 5, 3, 9, color, 0.95).setDepth(40);
      this.tweens.add({
        targets: star,
        x: x + Math.cos(angle) * Phaser.Math.Between(18, 48),
        y: y + Math.sin(angle) * Phaser.Math.Between(18, 48),
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

  private spawnSpeedFlash(): void {
    for (let i = 0; i < 5; i += 1) {
      const y = this.player.y - 35 - i * 12;
      const line = this.add.rectangle(
        this.player.x - this.player.facing * (42 + i * 20),
        y,
        70,
        5,
        characters.akari.color,
        0.5,
      );
      line.setDepth(15);
      this.tweens.add({
        targets: line,
        x: line.x - this.player.facing * 70,
        alpha: 0,
        duration: 240,
        ease: "Quad.easeOut",
        onComplete: () => line.destroy(),
      });
    }
  }

  private spawnDinosaurChargeTrail(x: number, y: number, direction: -1 | 1): void {
    for (let i = 0; i < 8; i += 1) {
      const trail = this.add.rectangle(x - direction * i * 18, y + Phaser.Math.Between(-14, 18), 42, 6, 0xff6b32, 0.52);
      trail.setDepth(16);
      this.tweens.add({
        targets: trail,
        x: trail.x - direction * (70 + i * 8),
        alpha: 0,
        duration: 360,
        ease: "Quad.easeOut",
        onComplete: () => trail.destroy(),
      });
    }
  }
}
