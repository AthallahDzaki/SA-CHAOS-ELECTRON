async function _internal_Convert(string) {
    let ConvertVehicleFunction = (string) => {
        // Example : AddEffect(new SpawnVehicleEffect("TrueGrime", 408)); // Spawn Trashmaster
        let ret = {
            category: "Vehicle",
            name: string.split('"')[1],
            id: string.split('",')[1].split(")")[0].replace(" ", ""),
        };
        return ret;
    };
    let ConvertCustomVehicleSpawnsFunction = (string) => {
        // Example : AddEffect(new CustomVehicleSpawnsEffect(422, "BobcatAllAround"));
        let ret = {
            category: "CustomVehicle",
            id: string
                .split("AddEffect(new CustomVehicleSpawnsEffect(")[1]
                .split(",")[0]
                .replace(" ", ""),
            name: string.split('"')[1],
        };
        return ret;
    };
    let ConvertWeatherFunction = (string) => {
        // Example : AddEffect(new WeatherEffect("Foggy Weather", "CantSeeWhereImGoing", 9));
        let ret = {
            category: "Weather",
            name: string
                .split('AddEffect(new WeatherEffect("')[1]
                .split('"')[0],
            description: string
                .split('", "')[1]
                .split('",')[0]
                .replace(" ", ""),
            id: string.split(",")[2].split("));")[0].replace(" ", ""),
        };
        console.log(ret);
        return ret;
    };
    let ConvertFakeCrashEffect = (string) => {
        //Example : AddEffect(new FakeCrashEffect("Game Crash", "TooManyModsInstalled"));
        let ret = {
            category: "Crash",
            name: string
                .split('AddEffect(new FakeCrashEffect("')[1]
                .split('"')[0],
            description: string
                .split('", "')[1]
                .split('"));')[0]
                .replace(" ", ""),
        };
        return ret;
    };
    let ConvertFakeTeleportEffect = (string) => {
        // Example : AddEffect(new FakeTeleportEffect("Fake Teleport", "HahaGotYourNose")); // Fake Teleport
        let ret = {
            category: "Teleportation",
            name: string
                .split('AddEffect(new FakeTeleportEffect("')[1]
                .split('"')[0],
            description: string
                .split('", "')[1]
                .split(",")[0]
                .split('"));')[0]
                .replace(" ", ""),
        };
        return ret;
    };
    // Example AddEffect(new FunctionEffect(Category.NPCs, "Aggressive Drivers", "AllDriversAreCriminals", "aggressive_drivers")); // Aggressive drivers
    let lines = string.split("\n");
    let ret = {
        Function: [],
        Location: [],
    };
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] == "" || lines[i].startsWith("//")) continue;
        // Example : AddEffect(new FunctionEffect(Category.WeaponsAndHealth, "Health, Armor, $250k", "INeedSomeHelp", "health_armor_money")); // Health, Armor, $250k
        let line = [];
        if (lines[i].includes("new WeatherEffect")) {
            line = ConvertWeatherFunction(lines[i]);
        } else if (lines[i].includes("new SpawnVehicleEffect")) {
            line = ConvertVehicleFunction(lines[i]);
        } else if (lines[i].includes("new CustomVehicleSpawnsEffect")) {
            line = ConvertCustomVehicleSpawnsFunction(lines[i]);
        } else if (lines[i].includes("new FakeCrashEffect")) {
            line = ConvertFakeCrashEffect(lines[i]);
        } else if (lines[i].includes("new FakeTeleportEffect")) {
            line = ConvertFakeTeleportEffect(lines[i]);
        } else {
            line = {
                category: lines[i]
                    .split("AddEffect(new FunctionEffect(Category.")[1]
                    .split(', "')[0],
                name: lines[i].split('"')[1].split('"')[0],
                description: lines[i]
                    .split('", "')[1]
                    .split('",')[0]
                    .replace(" ", ""),
                id: lines[i].split('", "')[2].split('"));')[0].replace(" ", ""),
                exclusive: false,
            };
            if(line.id.includes('",'))
                line.id = line.id.split('",')[0];
            if(line.id.includes(');'))
                line.id = line.id.split(');')[0];
            if(line.id.includes('"'))
                line.id = line.id.split('"')[0];
        }
        ret["Function"].push(line);
    }
    ret["Location"] = [
        {
            name: "Groove Street",
            description: "BringMeHome",
            x: 2493,
            y: -1670,
            z: 15,
        },
        {
            name: "A Tower",
            description: "BringMeToATower",
            x: 1544,
            y: -1353,
            z: 332,
        },
        {
            name: "A Pier",
            description: "BringMeToAPier",
            x: 836,
            y: -2061,
            z: 15,
        },
        {
            name: "The LS Airport",
            description: "BringMeToTheLSAirport",
            x: 2109,
            y: -2544,
            z: 16,
        },
        {
            name: "The Docks",
            description: "BringMeToTheDocks",
            x: 2760,
            y: -2456,
            z: 16,
        },
        {
            name: "A Mountain",
            description: "BringMeToAMountain",
            x: -2233,
            y: -1737,
            z: 483,
        },
        {
            name: "The SF Airport",
            description: "BringMeToTheSFAirport",
            x: -1083,
            y: 409,
            z: 17,
        },
        {
            name: "A Bridge",
            description: "BringMeToABridge",
            x: -2669,
            y: 1595,
            z: 220,
        },
        {
            name: "A Secret Place",
            description: "BringMeToASecretPlace",
            x: 213,
            y: 1911,
            z: 20,
        },
        {
            name: "A Quarry",
            description: "BringMeToAQuarry",
            x: 614,
            y: 856,
            z: -40,
        },
        {
            name: "The LV Airport",
            description: "BringMeToTheLVAirport",
            x: 1612,
            y: 1166,
            z: 17,
        },
        {
            name: "Big Ear",
            description: "BringMeToBigEar",
            x: -310,
            y: 1524,
            z: 78,
        },
    ];
    return ret;
}

function _internal_isValidData(data) {
    let valid = true;
    if (data == undefined || data == null || data == "") valid = false;
    if (data.id.includes(" ")) valid = false;

    if (data.id.includes(");")) valid = false;
    if (data.id.includes(',"')) valid = false;
    return valid;
}

export async function Convert(string) {
    let check = await _internal_Convert(string);
    let checkSuccess = true;
    console.log(check);
    for (let i = 0; i < check.length; i++) {
        for (let j = 0; j < check[i].length; j++) {
            console.log(check);
            if (check[i] == "Location") continue;
            if (
                !_internal_isValidData(check[i][j].category) ||
                !_internal_isValidData(check[i][j].name) ||
                !_internal_isValidData(check[i][j].description) ||
                !_internal_isValidData(check[i][j].id)
            ) {
                console.log(`Error: ${check[i][j]}`);
                checkSuccess = false;
            }
        }
    }
    return checkSuccess ? check : "Error";
}
