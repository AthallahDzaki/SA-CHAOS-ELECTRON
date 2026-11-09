-- SA-Chaos Database Schema
-- Database: sa-chaos

CREATE TABLE IF NOT EXISTS `tokens` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `token` VARCHAR(255) NOT NULL UNIQUE,
  `owner` VARCHAR(255) DEFAULT NULL,
  `expired_at` BIGINT NOT NULL DEFAULT 0,
  `hwid` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `create_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_tokens_token` (`token`),
  INDEX `idx_tokens_owner` (`owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `token_de` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `token` VARCHAR(255) NOT NULL UNIQUE,
  `owner` VARCHAR(255) DEFAULT NULL,
  `expired_at` BIGINT NOT NULL DEFAULT 0,
  `hwid` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `create_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_token_de_token` (`token`),
  INDEX `idx_token_de_owner` (`owner`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `revenue_history` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `token_id` VARCHAR(255) DEFAULT NULL,
  `streamer` VARCHAR(255) NOT NULL,
  `amount` INT NOT NULL DEFAULT 0,
  `create_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_revenue_token` (`token_id`),
  INDEX `idx_revenue_streamer` (`streamer`),
  INDEX `idx_revenue_date` (`create_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
