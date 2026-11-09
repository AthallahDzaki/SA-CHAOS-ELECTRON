<?php
/**
 * Token Check & Validation API Endpoint for SA-Chaos
 * Returns token status, owner, expiration timestamp, and edition.
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

// Extract token from query param, post body, JSON body, or Authorization Bearer header
$rawInput = file_get_contents('php://input');
$json = json_decode($rawInput, true) ?? [];

$token = $_GET['token'] ?? $_POST['token'] ?? $json['token'] ?? $json['token_id'] ?? '';

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
        'message' => 'Token harus disertakan via query parameter ?token=, POST body, atau Authorization header'
    ]);
    exit;
}

$pdo = getPdoInstance();
if (!$pdo) {
    http_response_code(500);
    echo json_encode([
        'status' => 'error',
        'message' => 'Koneksi ke database gagal'
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
            'message' => 'Token tidak valid atau tidak terdaftar di sistem.'
        ]);
        exit;
    }

    $now = time();
    $expAt = (int)($row['expired_at'] ?? 0);
    $isExpired = false;
    if ($expAt > 0 && $expAt < 4000000000 && $expAt < $now) {
        $isExpired = true;
    }

    echo json_encode([
        'status'     => 'success',
        'valid'      => !$isExpired,
        'token'      => $row['token'],
        'owner'      => $row['owner'] ?? '',
        'edition'    => $row['edition'],
        'expired_at' => $expAt,
        'is_expired' => $isExpired,
        'message'    => $isExpired ? 'Token telah kedaluwarsa.' : 'Token valid dan aktif.'
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'status' => 'error',
        'message' => 'Database error: ' . $e->getMessage()
    ]);
}
