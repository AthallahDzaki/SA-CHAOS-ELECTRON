<?php
/**
 * SA-Chaos Central Server API Endpoint
 * Handles:
 * 1. Token check & validation (type=check / action=check)
 * 2. Diamond revenue tracking (type=diamond_tracking) with live=true verification & owner mismatch protection
 * 3. Game client credentials verification (type=credentials)
 */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With");
header("Content-Type: application/json; charset=UTF-8");

if (isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$db_host = 'localhost';
$db_user = 'root';
$db_pass = '';
$db_name = 'sa-chaos';
$db_port = 3306;

if (file_exists(__DIR__ . '/config.php')) {
    require_once __DIR__ . '/config.php';
}

function getPdoInstance() {
    global $db_host, $db_user, $db_pass, $db_name, $db_port;
    if (function_exists('getDbConnection')) {
        $conn = getDbConnection();
        if ($conn !== null) return $conn;
    }
    try {
        $dsn = "mysql:host=$db_host;dbname=$db_name;port=$db_port;charset=utf8mb4";
        return new PDO($dsn, $db_user, $db_pass, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        return null;
    }
}

function normalizeUsername($u) {
    if (!$u) return '';
    return strtolower(trim(ltrim(trim($u), '@')));
}

$rawInput = file_get_contents('php://input');
$inputData = json_decode($rawInput, true) ?? $_POST;

$type = $_GET['type'] ?? $_GET['action'] ?? $inputData['type'] ?? $inputData['action'] ?? '';

// If path or query includes /credentials
$requestUri = $_SERVER['REQUEST_URI'] ?? '';
if (empty($type)) {
    if (strpos($requestUri, '/credentials') !== false) {
        $type = 'credentials';
    } elseif (strpos($requestUri, '/check') !== false) {
        $type = 'check';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREDENTIALS VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────
if ($type === 'credentials') {
    $owner = trim($_GET['owner'] ?? $inputData['owner'] ?? $inputData['username'] ?? '');
    $currentLiveUser = trim($_GET['currentLiveUser'] ?? $_GET['uniqueId'] ?? $inputData['currentLiveUser'] ?? $inputData['uniqueId'] ?? '');
    $isLive = !empty($_GET['live']) || !empty($inputData['live']) || !empty($inputData['is_live']);

    $pdo = getPdoInstance();
    $tokenOwner = $owner;

    // If token passed instead of owner, find owner from DB
    $token = trim($_GET['token'] ?? $inputData['token'] ?? '');
    if (!empty($token) && $pdo) {
        $stmt = $pdo->prepare("
            SELECT owner FROM token_de WHERE token = ?
            UNION ALL
            SELECT owner FROM tokens WHERE token = ?
            LIMIT 1
        ");
        $stmt->execute([$token, $token]);
        $tokRow = $stmt->fetch();
        if ($tokRow && !empty($tokRow['owner'])) {
            $tokenOwner = trim($tokRow['owner']);
        }
    }

    $matched = true;
    $message = "Verifikasi credentials berhasil.";

    if (!empty($tokenOwner) && !empty($currentLiveUser)) {
        if (normalizeUsername($tokenOwner) !== normalizeUsername($currentLiveUser)) {
            $matched = false;
            $message = "Username TikTok tidak cocok dengan pemilik token! Akun live saat ini (@$currentLiveUser) berbeda dengan pemilik token terdaftar (@$tokenOwner). Silakan hubungi admin/developer (Athallah) untuk pergantian username.";
        }
    }

    echo json_encode([
        'type'            => 'credentials',
        'status'          => $matched ? 'success' : 'error',
        'matched'         => $matched,
        'owner'           => $tokenOwner,
        'currentLiveUser' => $currentLiveUser,
        'live'            => (bool)$isLive,
        'message'         => $message
    ]);
    exit();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TOKEN CHECK & VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
if ($type === 'check') {
    $token = $_GET['token'] ?? $_POST['token'] ?? $inputData['token'] ?? $inputData['token_id'] ?? '';
    if (empty($token)) {
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/Bearer\s+(\S+)/i', $authHeader, $matches)) {
            $token = $matches[1];
        }
    }
    $token = trim($token);

    if (empty($token)) {
        http_response_code(400);
        echo json_encode([
            'status' => 'error',
            'code' => 'TOKEN_MISSING',
            'message' => 'Parameter token tidak ditemukan.'
        ]);
        exit;
    }

    $pdo = getPdoInstance();
    if (!$pdo) {
        http_response_code(500);
        echo json_encode([
            'status' => 'error',
            'message' => 'Database connection failed'
        ]);
        exit;
    }

    try {
        $stmt = $pdo->prepare("
            SELECT 'Definitive' as edition, token, owner, expired_at, hwid FROM token_de WHERE token = ?
            UNION ALL
            SELECT 'Classic' as edition, token, owner, expired_at, hwid FROM tokens WHERE token = ?
            LIMIT 1
        ");
        $stmt->execute([$token, $token]);
        $row = $stmt->fetch();

        if (!$row) {
            http_response_code(404);
            echo json_encode([
                'status' => 'error',
                'code' => 'TOKEN_NOT_FOUND',
                'message' => 'Token tidak ditemukan.'
            ]);
            exit;
        }

        $now = time();
        $expAt = (int)($row['expired_at'] ?? 0);
        $isExpired = ($expAt > 0 && $expAt < 4000000000 && $expAt < $now);

        echo json_encode([
            'status'     => 'success',
            'valid'      => !$isExpired,
            'token'      => $row['token'],
            'owner'      => $row['owner'] ?? '',
            'edition'    => $row['edition'],
            'expired_at' => $expAt,
            'is_expired' => $isExpired,
            'message'    => $isExpired ? 'Token telah expired.' : 'Token valid.'
        ]);
        exit;
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode([
            'status' => 'error',
            'message' => 'Database error: ' . $e->getMessage()
        ]);
        exit;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DIAMOND TRACKING
// ─────────────────────────────────────────────────────────────────────────────
if ($type === 'diamond_tracking') {
    $token_id = trim($inputData['token_id'] ?? $inputData['token'] ?? '');
    $streamer = trim($inputData['streamer'] ?? $inputData['username'] ?? $inputData['owner'] ?? '');
    $amount   = intval($inputData['amount'] ?? $inputData['total_diamonds'] ?? 0);

    // Enforce live === true
    $isLive = false;
    if (isset($inputData['live'])) {
        $isLive = ($inputData['live'] === true || $inputData['live'] === 'true' || $inputData['live'] === 1 || $inputData['live'] === '1');
    } elseif (isset($inputData['is_live'])) {
        $isLive = ($inputData['is_live'] === true || $inputData['is_live'] === 'true' || $inputData['is_live'] === 1 || $inputData['is_live'] === '1');
    }

    if (!$isLive) {
        http_response_code(403);
        echo json_encode([
            'status' => 'error',
            'code' => 'STREAM_NOT_LIVE',
            'message' => 'Data revenue hanya dicatat saat TikTok sedang live (live = true) agar data revenue real.'
        ]);
        exit;
    }

    if (empty($streamer) || $amount <= 0) {
        http_response_code(400);
        echo json_encode([
            'status' => 'error',
            'message' => 'Missing required fields: streamer or amount'
        ]);
        exit;
    }

    $pdo = getPdoInstance();
    if (!$pdo) {
        http_response_code(500);
        echo json_encode([
            'status' => 'error',
            'message' => 'Database connection failed'
        ]);
        exit;
    }

    try {
        if (!empty($token_id)) {
            $stmt = $pdo->prepare("
                SELECT 'Definitive' as edition, token, owner, expired_at FROM token_de WHERE token = ?
                UNION ALL
                SELECT 'Classic' as edition, token, owner, expired_at FROM tokens WHERE token = ?
                LIMIT 1
            ");
            $stmt->execute([$token_id, $token_id]);
            $tokenRow = $stmt->fetch();

            if ($tokenRow) {
                $dbOwner = trim($tokenRow['owner'] ?? '');
                if (!empty($dbOwner)) {
                    if (normalizeUsername($dbOwner) !== normalizeUsername($streamer)) {
                        http_response_code(403);
                        echo json_encode([
                            'status' => 'owner_mismatch',
                            'message' => "Username TikTok tidak cocok dengan pemilik token! Akun live saat ini (@$streamer) berbeda dengan pemilik token terdaftar (@$dbOwner). Silakan hubungi admin/developer (Athallah) untuk pergantian username.",
                            'owner' => $dbOwner,
                            'currentLiveUser' => $streamer
                        ]);
                        exit;
                    }
                } else {
                    $table = ($tokenRow['edition'] === 'Definitive') ? 'token_de' : 'tokens';
                    $upStmt = $pdo->prepare("UPDATE $table SET owner = ? WHERE token = ? AND (owner IS NULL OR owner = '')");
                    $upStmt->execute([$streamer, $token_id]);
                }
            }
        }

        $stmt = $pdo->prepare("INSERT INTO revenue_history (token_id, streamer, amount, create_at) VALUES (:token_id, :streamer, :amount, NOW())");
        $stmt->execute([
            ':token_id' => $token_id,
            ':streamer' => $streamer,
            ':amount'   => $amount
        ]);

        echo json_encode([
            'status'   => 'success',
            'message'  => 'Diamond tracking recorded successfully',
            'id'       => $pdo->lastInsertId(),
            'amount'   => $amount,
            'streamer' => $streamer
        ]);
        exit;
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode([
            'status'  => 'error',
            'message' => 'Database error: ' . $e->getMessage()
        ]);
        exit;
    }
}

// Fallback: Welcome / Info
echo json_encode([
    'name'    => 'SA-Chaos Central Server API',
    'status'  => 'online',
    'endpoints' => [
        'check'            => '?type=check&token=<token>',
        'diamond_tracking' => '?type=diamond_tracking (POST)',
        'credentials'      => '?type=credentials&owner=<owner>&currentLiveUser=<uniqueId>'
    ]
]);
