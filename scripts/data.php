<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With");
header("Content-Type: application/json; charset=UTF-8");

if (isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Database configuration
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

$type = $_GET['type'] ?? $_POST['type'] ?? '';

// Read raw JSON input or POST body
$inputRaw = file_get_contents('php://input');
$inputData = json_decode($inputRaw, true) ?? $_POST;
if (empty($type) && isset($inputData['type'])) {
    $type = $inputData['type'];
}

if ($type !== 'diamond_tracking') {
    http_response_code(400);
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid request type. Expected type=diamond_tracking'
    ]);
    exit;
}

$token_id = trim($inputData['token_id'] ?? $inputData['token'] ?? '');
$streamer = trim($inputData['streamer'] ?? $inputData['username'] ?? $inputData['owner'] ?? '');
$amount   = intval($inputData['amount'] ?? $inputData['total_diamonds'] ?? 0);

// Live requirement for revenue tracking
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
    // Check token and verify owner if token_id is provided
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
                // If owner is empty in database, bind/register the streamer as owner
                $table = ($tokenRow['edition'] === 'Definitive') ? 'token_de' : 'tokens';
                $upStmt = $pdo->prepare("UPDATE $table SET owner = ? WHERE token = ? AND (owner IS NULL OR owner = '')");
                $upStmt->execute([$streamer, $token_id]);
            }
        }
    }

    // Insert revenue tracking
    $stmt = $pdo->prepare("INSERT INTO revenue_history (token_id, streamer, amount, create_at) VALUES (:token_id, :streamer, :amount, NOW())");
    $stmt->execute([
        ':token_id' => $token_id,
        ':streamer' => $streamer,
        ':amount'   => $amount
    ]);

    echo json_encode([
        'status'  => 'success',
        'message' => 'Diamond tracking recorded successfully',
        'id'      => $pdo->lastInsertId(),
        'amount'  => $amount,
        'streamer'=> $streamer
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'status'  => 'error',
        'message' => 'Database error: ' . $e->getMessage()
    ]);
}
?>
