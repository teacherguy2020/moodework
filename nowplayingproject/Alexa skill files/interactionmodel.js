{
    "interactionModel": {
        "languageModel": {
            "invocationName": "mood audio",
            "intents": [
                {
                    "name": "AMAZON.CancelIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.HelpIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.StopIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.FallbackIntent",
                    "samples": []
                },
                {
                    "name": "NowPlayingIntent",
                    "slots": [],
                    "samples": [
                        "who is singing",
                        "who is this",
                        "name the song",
                        "name the track",
                        "name this track",
                        "name this song",
                        "what song is playing",
                        "what track is playing",
                        "what's this",
                        "what track is this",
                        "what's the name of this song",
                        "what's the name of this",
                        "what song is this",
                        "what's playing"
                    ]
                },
                {
                    "name": "PlayAlbumIntent",
                    "slots": [
                        {
                            "name": "album",
                            "type": "AMAZON.SearchQuery"
                        }
                    ],
                    "samples": [
                        "play album {album}",
                        "play the album {album}",
                        "start album {album}",
                        "queue album {album}",
                        "queue the album {album}"
                    ]
                },
                {
                    "name": "PlayPlaylistIntent",
                    "slots": [
                        {
                            "name": "playlist",
                            "type": "AMAZON.SearchQuery"
                        }
                    ],
                    "samples": [
                        "play playlist {playlist}",
                        "play the playlist {playlist}",
                        "start playlist {playlist}",
                        "start the playlist {playlist}",
                        "queue playlist {playlist}",
                        "queue the playlist {playlist}",
                        "play my playlist {playlist}",
                        "start my playlist {playlist}"
                    ]
                },
                {
                    "name": "AMAZON.PauseIntent",
                    "samples": []
                },
                {
                    "name": "AMAZON.ResumeIntent",
                    "samples": []
                }
            ],
            "types": []
        }
    }
}